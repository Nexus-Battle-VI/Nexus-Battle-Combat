import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { BattleEventType, type BattleEvent } from '../../src/domain/entities/BattleEvent'
import { RoomConflictError } from '../../src/application/errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import { BattleDeadlineSettler } from '../../src/application/services/BattleDeadlineSettler'
import { NOW } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'
import { finalizationHarness, mutableClock } from '../fixtures/finalization'

const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs)

/** Sala con el turno renovado a un instante concreto (aísla el vencimiento global). */
const withTurnStartedAt = (room: BattleRoom, startedAt: Date): BattleRoom => {
  const snapshot = room.toSnapshot()
  const battle = snapshot.battle

  if (battle === null) {
    throw new Error('La sala de prueba necesita batalla.')
  }

  return BattleRoom.restore({ ...snapshot, battle: { ...battle, turnStartedAt: startedAt } })
}

/**
 * Liquidacion de vencimientos (HU-21, contrato §3, §4.5 y §7): una sola
 * escritura por transicion, difusion DESPUES de persistir y efecto de fin solo
 * cuando la sala queda FINISHED.
 */
describe('BattleDeadlineSettler — una sola escritura y publicacion posterior', () => {
  it('sin vencimientos no escribe, no difunde y no finaliza', async () => {
    const clock = mutableClock(NOW)
    const h = finalizationHarness([], clock)
    const persisted = await h.rooms.save(battleWithCombat(), 0)

    let saves = 0
    const original = h.rooms.save.bind(h.rooms)

    h.rooms.save = async (next, version) => {
      saves += 1

      return original(next, version)
    }

    const result = await h.settler.settle(persisted)

    expect(result).toBe(persisted)
    expect(saves).toBe(0)
    expect(h.published).toEqual([])
    expect(h.notifications).toEqual([])
  })

  it('un turno vencido: UNA escritura, publica `turnTimedOut` DESPUES y reprograma el proximo vencimiento', async () => {
    const clock = mutableClock(at(30_000))
    const h = finalizationHarness([], clock)
    const room = battleWithCombat()
    const persisted = await h.rooms.save(room, 0)

    const saved = await h.settler.settle(persisted)

    expect(saved.battle?.turnsCompleted).toBe(1)
    expect(h.published).toHaveLength(1)
    expect(h.published[0]?.events.map((event) => event.type)).toEqual([
      BattleEventType.TurnTimedOut,
    ])
    expect(h.order).toEqual(['publish:turnTimedOut'])
    expect(h.book.due.get(room.id)).toEqual(at(60_000))
    expect(h.notifications).toEqual([])
  })

  it('el vencimiento global finaliza: primero difunde y despues ejecuta los efectos de fin', async () => {
    const clock = mutableClock(at(360_000))
    const h = finalizationHarness([], clock)
    const persisted = await h.rooms.save(withTurnStartedAt(battleWithCombat(), at(330_000)), 0)

    const saved = await h.settler.settle(persisted)

    expect(saved.status).toBe('FINISHED')
    expect(saved.result?.reason).toBe('TIME_LIMIT')
    expect(h.order).toEqual([
      'publish:battleFinished',
      'notify:FINISHED',
      `release:${persisted.id}`,
      'publish:result',
    ])
    expect(h.book.due.size).toBe(0)
    expect(h.notifications).toHaveLength(1)
  })

  it('una gracia vencida finaliza por desconexion y pasa por el finalizador', async () => {
    const clock = mutableClock(at(30_000))
    const h = finalizationHarness([], clock)
    const persisted = await h.rooms.save(battleWithCombat(), 0)

    h.presence.markAbsent(persisted.id, 'a1', NOW)

    const saved = await h.settler.settle(persisted)

    expect(saved.result?.reason).toBe('DISCONNECTION')
    expect(saved.result?.winnerTeamLabel).toBe('B')
    expect(h.notifications).toHaveLength(1)
  })

  it('ante un conflicto de version NO reintenta ni vuelve a sortear: relee y devuelve lo vigente', async () => {
    const clock = mutableClock(at(30_000))
    const h = finalizationHarness([], clock)
    const persisted = await h.rooms.save(battleWithCombat(), 0)

    // Otro escritor avanzo la sala antes de nuestro save.
    const current = await h.rooms.findById(persisted.id)

    if (current === null) {
      throw new Error('la sala debia existir')
    }

    await h.rooms.save(current.completeTurn('a1', 'cmd-otro', at(20_000)), persisted.version)

    let saves = 0
    const conflict: BattleRoomRepositoryPort = {
      findById: (id) => h.rooms.findById(id),
      findWaitingForPlayers: () => h.rooms.findWaitingForPlayers(),
      findInBattle: () => h.rooms.findInBattle(),
      findFinishedSince: (since) => h.rooms.findFinishedSince(since),
      save: () => {
        saves += 1

        return Promise.reject(new RoomConflictError(persisted.id))
      },
    }
    const events = {
      publish: (roomId: string, fresh: readonly BattleEvent[]): void => {
        h.order.push(`conflict-publish:${String(fresh.length)}:${roomId}`)
      },
    }
    const conflicted = new BattleDeadlineSettler(
      conflict,
      h.presence,
      h.book,
      clock,
      events,
      h.finalizer,
    )

    const result = await conflicted.settle(persisted)

    expect(saves).toBe(1)
    expect(result.battle?.turnsCompleted).toBe(1)
    expect(h.order.filter((entry) => entry.startsWith('conflict-publish'))).toEqual([])
  })
})
