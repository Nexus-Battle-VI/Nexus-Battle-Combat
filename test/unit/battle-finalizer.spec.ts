import { BattleRoomStatus } from '../../src/domain/value-objects/BattleRoomStatus'
import { NOW } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'
import { finalizationHarness } from '../fixtures/finalization'

const AT = new Date('2026-09-21T10:05:00.000Z')

const finishedRoom = () =>
  battleWithCombat({ health: { 'B#0': 0 } }).finish(
    { reason: 'ELIMINATION', winnerTeamLabel: 'A' },
    AT,
  )

/**
 * Efectos posteriores a persistir `FINISHED` (HU-21, contrato §8 y §9), en
 * orden fijo y sin poder reventar la operacion.
 */
describe('BattleFinalizer — orden, resiliencia y notificacion', () => {
  it('ejecuta los cinco pasos en orden: vencimientos, presencia, lobby, liberacion y notificacion', () => {
    const h = finalizationHarness()
    const room = finishedRoom()

    h.book.ensureDueBy(room.id, NOW)
    h.presence.markAbsent(room.id, 'a1', NOW)

    h.finalizer.afterFinished(room)

    expect(h.book.due.size).toBe(0)
    expect(h.presence.absences(room.id).size).toBe(0)
    expect(h.order).toEqual(['notify:FINISHED', `release:${room.id}`, 'publish:result'])
    expect(h.notifications).toHaveLength(1)
  })

  it('un fallo en un paso NO impide los siguientes, y queda registrado', () => {
    const h = finalizationHarness()
    const room = finishedRoom()

    // El notificador del lobby revienta: liberacion y notificacion deben seguir.
    h.notifier.notifyRoomUpdated = () => {
      throw new Error('socket caido')
    }

    expect(() => {
      h.finalizer.afterFinished(room)
    }).not.toThrow()

    expect(h.order).toContain(`release:${room.id}`)
    expect(h.order).toContain('publish:result')
    expect(h.order).toContain('log:error')
  })

  it('publica los derechos de credito del §9 y la recompensa configurada, sin acreditar nada', () => {
    const h = finalizationHarness()
    const room = finishedRoom()

    h.finalizer.afterFinished(room)

    const notification = h.notifications[0]

    expect(notification).toMatchObject({
      roomId: room.id,
      mode: 'PVP',
      reason: 'ELIMINATION',
      outcome: 'WIN',
      winnerTeamLabel: 'A',
      finishedAt: AT.toISOString(),
      configuredReward: { amount: 10 },
    })
    expect(notification?.participants).toEqual([
      {
        kind: 'HUMAN',
        playerId: 'a1',
        heroId: 'hero-a1',
        teamLabel: 'A',
        seat: 0,
        result: 'WON',
        credits: 2,
      },
      {
        kind: 'HUMAN',
        playerId: 'b1',
        heroId: 'hero-b1',
        teamLabel: 'B',
        seat: 0,
        result: 'LOST',
        credits: 1,
      },
    ])
  })

  it('sin resultado (sala aun en curso) no publica notificacion de consumidores', () => {
    const h = finalizationHarness()
    const room = battleWithCombat()

    h.finalizer.afterFinished(room)

    expect(room.status).not.toBe(BattleRoomStatus.Finished)
    expect(h.notifications).toEqual([])
  })
})
