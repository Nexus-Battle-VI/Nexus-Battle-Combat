import { RandomPolicy } from '../../src/application/policies/RandomPolicy'
import { createBoundedRandom } from '../../src/application/services/BoundedRandom'
import { NoLegalDecisionActionsError } from '../../src/domain/errors/DecisionContractErrors'
import { scriptedSequence } from '../fixtures/battle'
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

describe('RandomPolicy (EN-035.3, ADR-023)', () => {
  it('T-RND-01: a single candidate is always returned, without consuming the stream', () => {
    const sequence = scriptedSequence([])
    const policy = new RandomPolicy(createBoundedRandom(sequence))

    return policy.decide(STATE, [basicAttack]).then((intent) => {
      expect(intent).toEqual(basicAttack)
      expect(sequence.consumed()).toBe(0)
    })
  })

  it('T-RND-02: never returns an action outside legalActions', async () => {
    const actions = [ability('a'), ability('b'), ability('c'), basicAttack]
    // 8000 es uniforme en todo el rango de RandomIndex: cubre varios índices.
    const sequence = scriptedSequence([1, 2000, 4000, 6000, 7999])
    const policy = new RandomPolicy(createBoundedRandom(sequence))

    for (let n = 0; n < 5; n += 1) {
      const intent = await policy.decide(STATE, actions)

      expect(actions).toContainEqual(intent)
    }
  })

  it('T-RND-03: a controlled stream gives a reproducible sequence of choices', async () => {
    const actions = [ability('a'), ability('b'), ability('c')]
    const indices = [1, 2667, 5334]
    const first = new RandomPolicy(createBoundedRandom(scriptedSequence(indices)))
    const second = new RandomPolicy(createBoundedRandom(scriptedSequence(indices)))
    const pick = async (policy: RandomPolicy): Promise<LegalAction[]> => [
      await policy.decide(STATE, actions),
      await policy.decide(STATE, actions),
      await policy.decide(STATE, actions),
    ]

    expect(await pick(first)).toEqual(await pick(second))
  })

  it('T-RND-04/05: does not mutate legalActions nor state, and never calls Math.random', async () => {
    const spy = jest.spyOn(Math, 'random')
    const actions = Object.freeze([ability('a'), ability('b')])
    const beforeState = JSON.stringify(STATE)
    const policy = new RandomPolicy(createBoundedRandom(scriptedSequence([1, 4000])))

    await policy.decide(STATE, actions)

    expect(actions).toHaveLength(2)
    expect(JSON.stringify(STATE)).toBe(beforeState)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('T-RND-06: an empty list throws NoLegalDecisionActionsError', async () => {
    const policy = new RandomPolicy(createBoundedRandom(scriptedSequence([1])))

    await expect(policy.decide(STATE, [])).rejects.toBeInstanceOf(NoLegalDecisionActionsError)
  })

  it('EN-035.3 §53: consuming RandomPolicy never advances a separate "live" combat sequence', async () => {
    const liveCombatSequence = scriptedSequence([1, 2, 3])
    const simulationSequence = scriptedSequence([4000, 5000])
    const policy = new RandomPolicy(createBoundedRandom(simulationSequence))

    await policy.decide(STATE, [ability('a'), ability('b'), ability('c')])

    expect(simulationSequence.consumed()).toBeGreaterThan(0)
    expect(liveCombatSequence.consumed()).toBe(0)
  })
})
