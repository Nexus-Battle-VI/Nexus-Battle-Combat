import {
  DecisionPolicySelector,
  type DecisionPolicyBinding,
} from '../../src/application/services/DecisionPolicySelector'
import { RuleBasedPolicy } from '../../src/application/policies/RuleBasedPolicy'
import { IllegalActionIntentError } from '../../src/domain/errors/DecisionContractErrors'
import type { AiDecisionPort } from '../../src/application/ports/AiDecisionPort'
import type { BattleDecisionState } from '../../src/domain/decision/BattleDecisionState'
import type { LegalAction } from '../../src/domain/decision/LegalAction'

const STATE: BattleDecisionState = Object.freeze({
  schemaVersion: 1,
  context: { battleId: 'battle-1', mode: 'PVE' as const, round: 1, turnsCompleted: 0 },
  actor: {
    identity: { teamLabel: 'HERO', seat: 0 },
    kind: 'AI' as const,
    heroSubtype: 'GUERRERO_TANQUE',
    health: { current: 10, max: 10 },
    power: { current: 5, max: 5 },
    attack: 10,
    defense: 8,
    damage: { mode: 'FIXED' as const, amount: 1 },
    level: null,
    cooldowns: [],
    abilities: [],
    epic: null,
    activeEffects: [],
    damageMemory: null,
  },
  allies: [],
  enemies: [],
})

const target = Object.freeze({
  scope: 'COMBATANT' as const,
  combatant: { teamLabel: 'ENEMY', seat: 0 },
})
const basicAttack: LegalAction = Object.freeze({ kind: 'BASIC_ATTACK', target })
const ability = (abilityId: string): LegalAction =>
  Object.freeze({ kind: 'ABILITY', abilityId, target })

const ruleBased: DecisionPolicyBinding = {
  policy: new RuleBasedPolicy(),
  source: 'RULE_BASED',
}

/**
 * Management#558: "si la politica neuronal no esta disponible, falla o no
 * produce una decision utilizable -> `RuleBasedPolicy`". `DecisionPolicySelector`
 * es el unico punto que decide eso; hoy produccion la construye con
 * `primary: null` (sin `NeuralPolicy` entrenada todavia) y `RuleBasedPolicy`
 * como fallback FIJO (nunca `RandomPolicy`, que es solo el baseline
 * experimental de EN-035.3 para Misiones/evaluacion).
 */
describe('DecisionPolicySelector (Management#558)', () => {
  it('sin primaria (hoy en produccion): usa directamente el fallback', async () => {
    const selector = new DecisionPolicySelector(null, ruleBased)

    const selected = await selector.select(STATE, [ability('a'), basicAttack])

    expect(selected.source).toBe('RULE_BASED')
    expect(selected.action).toEqual(ability('a'))
  })

  it('primaria valida (NEURAL simulada): se usa su decision y su fuente', async () => {
    const validPrimary: AiDecisionPort = { decide: () => Promise.resolve(basicAttack) }
    const selector = new DecisionPolicySelector(
      { policy: validPrimary, source: 'NEURAL' },
      ruleBased,
    )

    const selected = await selector.select(STATE, [ability('a'), basicAttack])

    expect(selected.source).toBe('NEURAL')
    expect(selected.action).toEqual(basicAttack)
  })

  it('primaria que falla (NEURAL simulada): cae a RuleBasedPolicy, no a RANDOM', async () => {
    const failingPrimary: AiDecisionPort = { decide: () => Promise.reject(new Error('sin modelo')) }
    const selector = new DecisionPolicySelector(
      { policy: failingPrimary, source: 'NEURAL' },
      ruleBased,
    )

    const selected = await selector.select(STATE, [ability('a'), basicAttack])

    expect(selected.source).toBe('RULE_BASED')
    expect(selected.action).toEqual(ability('a'))
  })

  it('primaria que inventa una accion fuera de las legales: cae a RuleBasedPolicy', async () => {
    const inventingPrimary: AiDecisionPort = {
      decide: () => Promise.resolve(ability('inexistente')),
    }
    const selector = new DecisionPolicySelector(
      { policy: inventingPrimary, source: 'NEURAL' },
      ruleBased,
    )

    const selected = await selector.select(STATE, [ability('a'), basicAttack])

    expect(selected.source).toBe('RULE_BASED')
    expect(selected.action).toEqual(ability('a'))
  })

  it('si el propio fallback falla, el error se propaga (no hay un segundo fallback)', async () => {
    const failingPrimary: AiDecisionPort = { decide: () => Promise.reject(new Error('sin modelo')) }
    const failingFallback: DecisionPolicyBinding = {
      policy: { decide: () => Promise.reject(new IllegalActionIntentError()) },
      source: 'RULE_BASED',
    }
    const selector = new DecisionPolicySelector(
      { policy: failingPrimary, source: 'NEURAL' },
      failingFallback,
    )

    await expect(selector.select(STATE, [basicAttack])).rejects.toBeInstanceOf(
      IllegalActionIntentError,
    )
  })
})
