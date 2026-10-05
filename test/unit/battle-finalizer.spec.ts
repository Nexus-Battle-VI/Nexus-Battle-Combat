import { BattleRoomStatus } from '../../src/domain/value-objects/BattleRoomStatus'
import { NOW, finishedRoom as finishedRosterRoom } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'
import { finalizationHarness } from '../fixtures/finalization'
import { InMemoryCombatDecisionTelemetryRepository } from '../../src/adapters/outbound/persistence/InMemoryCombatDecisionTelemetryRepository'
import { Sha256CommandIdFingerprint } from '../../src/adapters/outbound/system/Sha256CommandIdFingerprint'
import { CombatDecisionRecorder } from '../../src/application/services/CombatDecisionRecorder'
import { BattleFinalizer } from '../../src/application/services/BattleFinalizer'

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
  it('appends one PII-free terminal outcome without mutating prior decisions', async () => {
    const h = finalizationHarness()
    const telemetry = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(
      telemetry,
      { now: () => AT },
      { error: jest.fn() },
      new Sha256CommandIdFingerprint(),
    )
    const finalizer = new BattleFinalizer(
      h.book,
      h.presence,
      h.notifier,
      h.release,
      h.results,
      h.commitments,
      { error: jest.fn() },
      recorder,
    )
    const room = finishedRoom()

    finalizer.afterFinished(room)
    await Promise.resolve()

    const outcome = await telemetry.findOutcome('ONLINE', room.id)
    expect(outcome).toMatchObject({
      eventType: 'COMBAT_DECISION_OUTCOME',
      battleId: room.id,
      outcome: {
        kind: 'BATTLE',
        reason: 'ELIMINATION',
        outcome: 'WIN',
        winnerTeamLabel: 'A',
      },
    })
    expect(JSON.stringify(outcome)).not.toMatch(/playerId|displayName|heroId|a1|b1/iu)
  })

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

/**
 * HU-93.3: la IA nunca es una entidad economica. El participante AI aparece
 * en la notificacion (igual que cualquier otro, sin ocultar el resultado),
 * pero con `credits: null` (BattleCreditsPolicy) y SIN compromiso que
 * liberar (nunca lo tuvo, HU-29). El HUMAN conserva su derecho normal, gane
 * o pierda: esta Task no le quita nada, solo aisla a la IA.
 */
describe('BattleFinalizer — la IA nunca es una entidad economica (HU-93.3)', () => {
  it('Humano gana contra IA: el humano conserva sus creditos, la IA queda en null y sin liberacion', () => {
    const h = finalizationHarness()
    const room = finishedRosterRoom({ aiInTeamB: 1, winnerTeamLabel: 'A' })

    h.finalizer.afterFinished(room)

    const notification = h.notifications[0]
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
        kind: 'AI',
        playerId: null,
        heroId: 'ai-0',
        teamLabel: 'B',
        seat: 0,
        result: 'LOST',
        credits: null,
      },
    ])
    expect(h.commitments.releases).toEqual([{ roomId: room.id, playerId: 'a1' }])
  })

  it('IA gana contra Humano: el resultado SIGUE siendo WIN de la IA; ella no recibe credito ni liberacion', () => {
    const h = finalizationHarness()
    const room = finishedRosterRoom({ aiInTeamB: 1, winnerTeamLabel: 'B' })

    h.finalizer.afterFinished(room)

    const notification = h.notifications[0]
    expect(notification?.outcome).toBe('WIN')
    expect(notification?.winnerTeamLabel).toBe('B')
    expect(notification?.participants).toEqual([
      {
        kind: 'HUMAN',
        playerId: 'a1',
        heroId: 'hero-a1',
        teamLabel: 'A',
        seat: 0,
        result: 'LOST',
        credits: 1,
      },
      {
        kind: 'AI',
        playerId: null,
        heroId: 'ai-0',
        teamLabel: 'B',
        seat: 0,
        result: 'WON',
        credits: null,
      },
    ])
    // El humano que PIERDE sigue liberando su compromiso (HU-29); la IA
    // jamas tuvo uno que liberar, gane o pierda.
    expect(h.commitments.releases).toEqual([{ roomId: room.id, playerId: 'a1' }])
  })
})

/**
 * HU-29: al terminar la batalla deja de aplicarse la restriccion temporal de
 * equipamiento, asi que el finalizador libera el compromiso de CADA humano. Va
 * despues de soltar la sala y antes de notificar a los consumidores, y un fallo
 * no puede impedir la notificacion: la batalla ya esta cerrada.
 */
describe('BattleFinalizer — liberacion del compromiso de batalla (HU-29)', () => {
  it('libera el compromiso de cada participante humano, una vez por sala', () => {
    const h = finalizationHarness()
    const room = finishedRoom()

    h.finalizer.afterFinished(room)

    expect(h.commitments.releases).toEqual([
      { roomId: room.id, playerId: 'a1' },
      { roomId: room.id, playerId: 'b1' },
    ])
  })

  it('libera DESPUES de soltar la sala y ANTES de notificar a los consumidores', () => {
    const h = finalizationHarness()
    const room = finishedRoom()
    const inner = h.commitments.release.bind(h.commitments)

    h.commitments.release = (roomId, playerId) => {
      h.order.push(`compromiso:${playerId}`)

      return inner(roomId, playerId)
    }

    h.finalizer.afterFinished(room)

    expect(h.order).toEqual([
      'notify:FINISHED',
      `release:${room.id}`,
      'compromiso:a1',
      'compromiso:b1',
      'publish:result',
    ])
  })

  it('un fallo al liberar se registra y NO impide notificar a los consumidores', async () => {
    const h = finalizationHarness()
    const room = finishedRoom()

    h.commitments.failReleases = true

    expect(() => {
      h.finalizer.afterFinished(room)
    }).not.toThrow()

    // La liberacion es fire-and-forget: su fallo se registra en un microtask.
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

    expect(h.order).toContain('log:error')
    expect(h.order).toContain('publish:result')
    expect(h.notifications).toHaveLength(1)
    expect(h.commitments.releases).toEqual([])
  })
})
