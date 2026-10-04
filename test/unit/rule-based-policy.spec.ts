import { RuleBasedPolicy } from '../../src/application/policies/RuleBasedPolicy'
import { NoLegalDecisionActionsError } from '../../src/domain/errors/DecisionContractErrors'
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

const basicAttack = (): LegalAction =>
  Object.freeze({
    kind: 'BASIC_ATTACK',
    target: Object.freeze({ scope: 'COMBATANT', combatant: { teamLabel: 'ENEMY', seat: 0 } }),
  })

const ability = (abilityId: string): LegalAction =>
  Object.freeze({
    kind: 'ABILITY',
    abilityId,
    target: Object.freeze({ scope: 'COMBATANT', combatant: { teamLabel: 'ENEMY', seat: 0 } }),
  })

describe('RuleBasedPolicy (EN-035.3)', () => {
  it('T-RB-01: a single candidate is returned as-is', async () => {
    const only = basicAttack()
    const intent = await new RuleBasedPolicy().decide(STATE, [only])

    expect(intent).toEqual(only)
  })

  it('T-RB-02: with several candidates, picks the first (priority already resolved by the caller)', async () => {
    const first = ability('golpe')
    const second = ability('embate')
    const intent = await new RuleBasedPolicy().decide(STATE, [first, second])

    expect(intent).toEqual(first)
  })

  it('T-RB-03: does not mutate legalActions', async () => {
    const actions = Object.freeze([basicAttack(), ability('golpe')])

    await new RuleBasedPolicy().decide(STATE, actions)

    expect(actions).toHaveLength(2)
  })

  it('T-RB-04: does not mutate state', async () => {
    const before = JSON.stringify(STATE)

    await new RuleBasedPolicy().decide(STATE, [basicAttack()])

    expect(JSON.stringify(STATE)).toBe(before)
  })

  it('T-RB-05: an empty list throws NoLegalDecisionActionsError', async () => {
    await expect(new RuleBasedPolicy().decide(STATE, [])).rejects.toBeInstanceOf(
      NoLegalDecisionActionsError,
    )
  })

  it('T-RB-06: the result always matches one of the received legalActions', async () => {
    const actions = [ability('a'), ability('b'), basicAttack()]
    const intent = await new RuleBasedPolicy().decide(STATE, actions)

    expect(actions).toContainEqual(intent)
  })

  it('T-RB-07: the same input gives the same output', async () => {
    const actions = [ability('a'), ability('b')]
    const policy = new RuleBasedPolicy()

    expect(await policy.decide(STATE, actions)).toEqual(await policy.decide(STATE, actions))
  })
})
