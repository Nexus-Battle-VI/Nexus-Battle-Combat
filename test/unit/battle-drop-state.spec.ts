import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import type { EpicUsedPayload } from '../../src/domain/entities/BattleEvent'
import type { VersusDropDecision } from '../../src/domain/entities/VersusDrop'
import {
  battleDropEvents,
  hasPendingVersusDrop,
} from '../../src/application/services/BattleDropState'
import { battleWithCombat } from '../fixtures/basic-attack'

const DECISION: VersusDropDecision = {
  killerPlayerId: 'a1',
  defeatedPlayerId: 'b1',
  resolution: {
    status: 'PENDING',
    evaluations: [],
    selected: {
      productInstanceId: 'physical-piece-1',
      productId: 'product-1',
      itemId: 'item-1',
      dropChanceBasisPoints: 10_000,
    },
  },
}

/**
 * BUG #582: `PersistVersusDropDecision` ya adhiere `versusDrop` a un evento
 * `epicUsed` (una epica con efecto `DAMAGE` puede ser letal, igual que un
 * ataque basico o una habilidad). `battleDropEvents`/`hasPendingVersusDrop`
 * son los unicos consumidores de ese dato -- si no reconocen `epicUsed`, la
 * decision persistida queda invisible para el scheduler de HU-30 (ver la
 * regresion de extremo a extremo con el motor real en
 * `interval-battle-drop-scheduler.spec.ts`).
 */
describe('BattleDropState — reconoce versusDrop en epicUsed (BUG #582)', () => {
  it('battleDropEvents encuentra la decision persistida en un evento epicUsed', () => {
    const base = battleWithCombat()
    const battleView = base.battleView()
    if (battleView === null) throw new Error('la sala deberia estar en batalla')
    const state = base.toSnapshot()
    const withEpicEvent = BattleRoom.restore({
      ...state,
      events: [
        ...state.events,
        {
          seq: state.events.length + 1,
          type: 'epicUsed',
          occurredAt: new Date('2026-10-05T00:00:00.000Z'),
          payload: {
            commandId: 'cmd-epic-letal',
            completedPosition: 0,
            actor: { teamLabel: 'A', seat: 0 },
            target: { teamLabel: 'B', seat: 0 },
            epic: { epicProductId: 'epic-1', name: 'Epica de prueba' },
            power: { before: 0, after: 0 },
            cooldown: { remainingTurns: 2 },
            appliedEffects: 1,
            targetHealth: { before: 9, after: 0 },
            versusDrop: DECISION,
            battle: battleView,
          } satisfies EpicUsedPayload,
        },
      ],
    })

    const found = battleDropEvents(withEpicEvent)

    expect(found).toEqual([{ seq: state.events.length + 1, decision: DECISION }])
    expect(hasPendingVersusDrop(withEpicEvent)).toBe(true)
  })

  it('sin ningun evento con versusDrop, sigue sin encontrar nada (no hay falso positivo)', () => {
    const base = battleWithCombat()

    expect(battleDropEvents(base)).toEqual([])
    expect(hasPendingVersusDrop(base)).toBe(false)
  })
})
