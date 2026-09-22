import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { BattleEventType } from '../../src/domain/entities/BattleEvent'
import { ProcessBattleDeadlines } from '../../src/application/use-cases/ProcessBattleDeadlines'
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
 * Barrido de vencimientos de UNA sala (HU-21, contrato §3): el planificador lo
 * llama por cada sala vencida. Persistir antes de difundir, una sola escritura
 * por pasada y no-op cuando la sala ya no esta en curso.
 */
describe('ProcessBattleDeadlines — liquidacion bajo el cerrojo de la sala', () => {
  it('un turno vencido se publica DESPUES de persistir, con una sola escritura', async () => {
    const clock = mutableClock(at(30_000))
    const h = finalizationHarness([], clock)
    const room = battleWithCombat()

    await h.rooms.save(room, 0)

    let saves = 0
    const original = h.rooms.save.bind(h.rooms)

    h.rooms.save = async (next, version) => {
      saves += 1
      h.order.push('save')

      return original(next, version)
    }

    const process = new ProcessBattleDeadlines(h.rooms, h.book, new ChannelLock(), h.settler)

    await process.execute(room.id)

    expect(saves).toBe(1)
    expect(h.order).toEqual(['save', 'publish:turnTimedOut'])
    expect((await h.rooms.findById(room.id))?.battle?.turnsCompleted).toBe(1)
  })

  it('el vencimiento global finaliza la batalla y ejecuta los efectos posteriores', async () => {
    const clock = mutableClock(at(360_000))
    const h = finalizationHarness([], clock)
    const room = withTurnStartedAt(battleWithCombat(), at(330_000))
    const snapshot = room.toSnapshot()

    await h.rooms.save(room, 0)

    const process = new ProcessBattleDeadlines(h.rooms, h.book, new ChannelLock(), h.settler)

    await process.execute(room.id)

    expect((await h.rooms.findById(room.id))?.status).toBe('FINISHED')
    expect(h.order).toEqual([
      'publish:battleFinished',
      'notify:FINISHED',
      `release:${snapshot.id}`,
      'publish:result',
    ])
    expect(h.notifications).toHaveLength(1)
  })

  it('una gracia vencida finaliza por desconexion', async () => {
    const clock = mutableClock(at(30_000))
    const h = finalizationHarness([], clock)
    const room = battleWithCombat()

    await h.rooms.save(room, 0)
    h.presence.markAbsent(room.id, 'a1', NOW)

    const process = new ProcessBattleDeadlines(h.rooms, h.book, new ChannelLock(), h.settler)

    await process.execute(room.id)

    expect((await h.rooms.findById(room.id))?.result?.reason).toBe('DISCONNECTION')
  })

  it('una sala ya FINISHED no escribe nada y cancela su registro de vencimientos', async () => {
    const clock = mutableClock(at(360_000))
    const h = finalizationHarness([], clock)
    const room = battleWithCombat()
    const persisted = await h.rooms.save(room, 0)
    const finished = persisted.finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, at(10_000))

    await h.rooms.save(finished, persisted.version)
    h.book.ensureDueBy(room.id, NOW)

    const process = new ProcessBattleDeadlines(h.rooms, h.book, new ChannelLock(), h.settler)

    await process.execute(room.id)

    expect(h.book.due.size).toBe(0)
    expect(h.notifications).toEqual([])
  })

  it('una sala inexistente cancela su vencimiento sin escribir', async () => {
    const h = finalizationHarness()
    const process = new ProcessBattleDeadlines(h.rooms, h.book, new ChannelLock(), h.settler)
    const missing = '99999999-9999-4999-8999-999999999999'

    h.book.ensureDueBy(missing, NOW)

    await process.execute(missing)

    expect(h.book.due.size).toBe(0)
    expect(h.published).toEqual([])
  })

  it('no re-sortea ni reescribe al repetir la pasada sobre un turno ya vencido', async () => {
    const clock = mutableClock(at(30_000))
    const h = finalizationHarness([], clock)
    const room = battleWithCombat()

    await h.rooms.save(room, 0)

    const process = new ProcessBattleDeadlines(h.rooms, h.book, new ChannelLock(), h.settler)

    await process.execute(room.id)
    const afterFirst = await h.rooms.findById(room.id)

    await process.execute(room.id)
    const afterSecond = await h.rooms.findById(room.id)

    // El reloj no se movio: el turno nuevo vence a los 60 s, asi que la segunda
    // pasada no encuentra nada vencido y no publica otro evento.
    expect(afterSecond?.battle?.turnsCompleted).toBe(afterFirst?.battle?.turnsCompleted)
    expect(
      h.published
        .flatMap((entry) => entry.events)
        .filter((e) => e.type === BattleEventType.TurnTimedOut),
    ).toHaveLength(1)
  })
})
