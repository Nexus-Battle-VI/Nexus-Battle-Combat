import {
  MissionRotationConstraint,
  type MissionRotation,
} from '../../src/application/services/MissionRotationConstraint'
import type { CombatAbility } from '../../src/domain/entities/CombatProfile'

const ENEMY_TARGET = Object.freeze({
  scope: 'COMBATANT' as const,
  combatant: { teamLabel: 'ENEMY', seat: 0 },
})
const SELF_TARGET = Object.freeze({ scope: 'SELF' as const })
const GROUP_TARGET = Object.freeze({ scope: 'ALLIED_GROUP' as const })

const damageAbility = (abilityId: string, cost = 1, chargeTurns = 0): CombatAbility => ({
  abilityId,
  name: abilityId,
  powerCost: { mode: 'FIXED', amount: cost },
  chargeTurns,
  effects: [
    {
      kind: 'STAT_MODIFIER',
      target: 'SELF',
      statistic: 'DAMAGE',
      operation: 'INCREASE',
      magnitude: { mode: 'FIXED', amount: 1 },
      hasActivationCondition: false,
    },
  ],
})

const directDamageAbility = (abilityId: string, cost = 1): CombatAbility => ({
  abilityId,
  name: abilityId,
  powerCost: { mode: 'FIXED', amount: cost },
  chargeTurns: 0,
  effects: [
    {
      kind: 'DAMAGE',
      target: 'OPPONENT',
      magnitude: { mode: 'FIXED', amount: 5 },
      hasActivationCondition: false,
    },
  ],
})

const debuffAbility = (abilityId: string, cost = 1): CombatAbility => ({
  abilityId,
  name: abilityId,
  powerCost: { mode: 'FIXED', amount: cost },
  chargeTurns: 0,
  effects: [
    {
      kind: 'STAT_MODIFIER',
      target: 'OPPONENT',
      statistic: 'ATTACK',
      operation: 'DECREASE',
      magnitude: { mode: 'FIXED', amount: 1 },
      hasActivationCondition: false,
    },
  ],
})

const healAbility = (abilityId: string, cost = 1): CombatAbility => ({
  abilityId,
  name: abilityId,
  powerCost: { mode: 'FIXED', amount: cost },
  chargeTurns: 0,
  effects: [
    {
      kind: 'HEALING',
      target: 'SELF',
      magnitude: { mode: 'FIXED', amount: 5 },
      hasActivationCondition: false,
    },
  ],
})

const groupHealAbility = (abilityId: string, cost = 1): CombatAbility => ({
  abilityId,
  name: abilityId,
  powerCost: { mode: 'FIXED', amount: cost },
  chargeTurns: 0,
  effects: [
    {
      kind: 'HEALING',
      target: 'ALLIED_GROUP',
      magnitude: { mode: 'FIXED', amount: 5 },
      hasActivationCondition: false,
    },
  ],
})

const defenseBuffAbility = (abilityId: string, cost = 1): CombatAbility => ({
  abilityId,
  name: abilityId,
  powerCost: { mode: 'FIXED', amount: cost },
  chargeTurns: 0,
  effects: [
    {
      kind: 'STAT_MODIFIER',
      target: 'SELF',
      statistic: 'DEFENSE',
      operation: 'INCREASE',
      magnitude: { mode: 'FIXED', amount: 5 },
      hasActivationCondition: false,
    },
  ],
})

const baseInput = (overrides: {
  readonly rotations: readonly MissionRotation[]
  readonly abilities?: readonly CombatAbility[]
  readonly cooldowns?: ReadonlyMap<string, number>
  readonly power?: number
  readonly health?: number
  readonly maxHealth?: number
  readonly canAttack?: boolean
  readonly cursors?: Map<number, number>
}) => ({
  rotations: overrides.rotations,
  cursors: overrides.cursors ?? new Map<number, number>(),
  abilities: new Map((overrides.abilities ?? []).map((a) => [a.abilityId, a])),
  cooldowns: overrides.cooldowns ?? new Map<string, number>(),
  power: overrides.power ?? 10,
  health: overrides.health ?? 100,
  maxHealth: overrides.maxHealth ?? 100,
  canAttack: overrides.canAttack ?? true,
  enemyTarget: ENEMY_TARGET,
})

describe('MissionRotationConstraint (EN-035.3, HU-71, revisión de PR #71)', () => {
  it('MRC-01: a single viable rotation offers exactly its action', () => {
    const golpe = damageAbility('golpe')
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [golpe],
        rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'golpe' }] }],
      }),
    )

    expect(evaluation.legalActions).toEqual([
      { kind: 'ABILITY', abilityId: 'golpe', target: ENEMY_TARGET },
    ])
  })

  it('MRC-02: only the first viable rotation is offered, enforcing strict priority', () => {
    const golpe = damageAbility('golpe')
    const barata = damageAbility('barata')
    const lento = damageAbility('lento')
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [golpe, barata, lento],
        rotations: [
          { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'golpe' }] },
          { priority: 'MEDIUM', steps: [{ kind: 'ABILITY', abilityId: 'barata' }] },
          { priority: 'LOW', steps: [{ kind: 'ABILITY', abilityId: 'lento' }] },
        ],
      }),
    )

    expect(evaluation.legalActions).toEqual([
      { kind: 'ABILITY', abilityId: 'golpe', target: ENEMY_TARGET },
    ])
  })

  it('MRC-03: HIGH not viable (NOT_ENOUGH_POWER) is skipped, MEDIUM is still offered', () => {
    const cara = damageAbility('cara', 99)
    const barata = damageAbility('barata', 1)
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [cara, barata],
        power: 5,
        rotations: [
          { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'cara' }] },
          { priority: 'MEDIUM', steps: [{ kind: 'ABILITY', abilityId: 'barata' }] },
        ],
      }),
    )

    expect(evaluation.legalActions).toEqual([
      { kind: 'ABILITY', abilityId: 'barata', target: ENEMY_TARGET },
    ])

    const strategy = evaluation.resolve(evaluation.legalActions[0]!)

    expect(strategy).toEqual({
      rotation: 'MEDIUM',
      step: 1,
      fallback: false,
      skipped: [{ rotation: 'HIGH', step: 1, reason: 'NOT_ENOUGH_POWER' }],
    })
  })

  it('MRC-04: no viable rotation falls back to BASIC_ATTACK with fallback: true', () => {
    const cara = damageAbility('cara', 99)
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [cara],
        power: 1,
        rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'cara' }] }],
      }),
    )

    expect(evaluation.legalActions).toEqual([{ kind: 'BASIC_ATTACK', target: ENEMY_TARGET }])

    const strategy = evaluation.resolve(evaluation.legalActions[0]!)

    expect(strategy).toMatchObject({ rotation: null, step: null, fallback: true })
  })

  it('MRC-05: an explicit BASIC_ATTACK step is always viable, regardless of power/cooldown', () => {
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        power: 0,
        rotations: [{ priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK' }] }],
      }),
    )

    expect(evaluation.legalActions).toEqual([{ kind: 'BASIC_ATTACK', target: ENEMY_TARGET }])

    const strategy = evaluation.resolve(evaluation.legalActions[0]!)

    expect(strategy.fallback).toBe(false)
  })

  it('MRC-06: resolve() advances only the cursor of the strict-priority candidate', () => {
    const golpe = damageAbility('golpe')
    const barata = damageAbility('barata')
    const cursors = new Map<number, number>()
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [golpe, barata],
        cursors,
        rotations: [
          {
            priority: 'HIGH',
            steps: [{ kind: 'ABILITY', abilityId: 'golpe' }, { kind: 'BASIC_ATTACK' }],
          },
          { priority: 'MEDIUM', steps: [{ kind: 'ABILITY', abilityId: 'barata' }] },
        ],
      }),
    )

    expect(evaluation.legalActions).toEqual([
      { kind: 'ABILITY', abilityId: 'golpe', target: ENEMY_TARGET },
    ])
    expect(cursors.size).toBe(0)

    // La unica candidata ofrecida es la de HIGH.
    evaluation.resolve(evaluation.legalActions[0]!)

    expect(cursors.get(0)).toBe(1)
    expect(cursors.has(1)).toBe(false)
  })

  it('MRC-07: a non-viable step keeps its rotation cursor (never advances on skip)', () => {
    const golpe = damageAbility('golpe', 1, 3)
    const cursors = new Map<number, number>([[0, 0]])
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [golpe],
        cursors,
        cooldowns: new Map([['golpe', 2]]),
        rotations: [
          { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'golpe' }] },
          { priority: 'MEDIUM', steps: [{ kind: 'BASIC_ATTACK' }] },
        ],
      }),
    )

    const strategy = evaluation.resolve(evaluation.legalActions[0]!)

    expect(cursors.get(0)).toBe(0)
    expect(strategy.skipped).toEqual([{ rotation: 'HIGH', step: 1, reason: 'ON_COOLDOWN' }])
  })

  it('MRC-08: skip reasons cover unknown ability and unsupported effect', () => {
    const unsupported: CombatAbility = {
      abilityId: 'misteriosa',
      name: 'misteriosa',
      powerCost: { mode: 'FIXED', amount: 1 },
      chargeTurns: 0,
      effects: [
        {
          kind: 'STAT_MODIFIER',
          target: 'ENEMY',
          statistic: 'DEFENSE',
          operation: 'DECREASE',
          magnitude: { mode: 'FIXED', amount: 1 },
          hasActivationCondition: false,
        },
      ],
    }
    const unknown = new MissionRotationConstraint().evaluate(
      baseInput({
        rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'no-existe' }] }],
      }),
    )
    const unsupportedResult = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [unsupported],
        rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'misteriosa' }] }],
      }),
    )

    expect(unknown.resolve(unknown.legalActions[0]!).skipped).toEqual([
      { rotation: 'HIGH', step: 1, reason: 'UNKNOWN_ABILITY' },
    ])
    expect(unsupportedResult.resolve(unsupportedResult.legalActions[0]!).skipped).toEqual([
      { rotation: 'HIGH', step: 1, reason: 'UNSUPPORTED_EFFECT' },
    ])
  })

  describe('MRC-09: health eligibility for healing (ADR-023)', () => {
    it('healthRatio >= 0.90 (exactly 90%) excludes a pure-healing ability', () => {
      const curar = healAbility('curar')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [curar],
          health: 90,
          maxHealth: 100,
          rotations: [
            { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'curar' }] },
            { priority: 'MEDIUM', steps: [{ kind: 'BASIC_ATTACK' }] },
          ],
        }),
      )

      expect(evaluation.legalActions).toEqual([{ kind: 'BASIC_ATTACK', target: ENEMY_TARGET }])
      expect(evaluation.resolve(evaluation.legalActions[0]!).skipped).toEqual([
        { rotation: 'HIGH', step: 1, reason: 'HEALTH_NOT_ELIGIBLE' },
      ])
    })

    it('healthRatio < 0.90 (89%) allows healing as a candidate', () => {
      const curar = healAbility('curar')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [curar],
          health: 89,
          maxHealth: 100,
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'curar' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'curar', target: SELF_TARGET },
      ])
    })

    it('a non-healing ability is never excluded by health ratio', () => {
      const golpe = damageAbility('golpe')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [golpe],
          health: 100,
          maxHealth: 100,
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'golpe' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'golpe', target: ENEMY_TARGET },
      ])
    })

    it('a hybrid ability (attacks + secondary heal) is NOT health-gated, even at full health', () => {
      // Sube DAMAGE propio (dispara `attacks: true`, ataca este turno) Y cura:
      // su efecto principal es ofensivo, no curativo -- no debe bloquearse por HP.
      const hibrida: CombatAbility = {
        abilityId: 'hibrida',
        name: 'hibrida',
        powerCost: { mode: 'FIXED', amount: 1 },
        chargeTurns: 0,
        effects: [
          {
            kind: 'STAT_MODIFIER',
            target: 'SELF',
            statistic: 'DAMAGE',
            operation: 'INCREASE',
            magnitude: { mode: 'FIXED', amount: 1 },
            hasActivationCondition: false,
          },
          {
            kind: 'HEALING',
            target: 'SELF',
            magnitude: { mode: 'FIXED', amount: 1 },
            hasActivationCondition: false,
          },
        ],
      }
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [hibrida],
          health: 100,
          maxHealth: 100,
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'hibrida' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'hibrida', target: ENEMY_TARGET },
      ])
    })
  })

  describe('MRC-10: strategic target semantics (revisión de PR #71)', () => {
    it('direct damage to the opponent targets the enemy', () => {
      const dardo = directDamageAbility('dardo')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [dardo],
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'dardo' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'dardo', target: ENEMY_TARGET },
      ])
    })

    it('a debuff on the opponent targets the enemy, even without an attack roll', () => {
      const cono = debuffAbility('cono')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [cono],
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'cono' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'cono', target: ENEMY_TARGET },
      ])
    })

    it('a self heal (below threshold) targets SELF, not the enemy', () => {
      const curar = healAbility('curar')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [curar],
          health: 10,
          maxHealth: 100,
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'curar' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'curar', target: SELF_TARGET },
      ])
    })

    it('a group heal targets ALLIED_GROUP', () => {
      const canto = groupHealAbility('canto')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [canto],
          health: 10,
          maxHealth: 100,
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'canto' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'canto', target: GROUP_TARGET },
      ])
    })

    it('a non-attacking self buff (e.g. DEFENSE) targets SELF', () => {
      const piedra = defenseBuffAbility('piedra')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [piedra],
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'piedra' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'piedra', target: SELF_TARGET },
      ])
    })

    it('a self buff that also attacks this turn (ATTACK/DAMAGE) targets the enemy', () => {
      const golpe = damageAbility('golpe')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [golpe],
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'golpe' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'golpe', target: ENEMY_TARGET },
      ])
    })

    it('BASIC_ATTACK always targets the enemy', () => {
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({ rotations: [{ priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK' }] }] }),
      )

      expect(evaluation.legalActions).toEqual([{ kind: 'BASIC_ATTACK', target: ENEMY_TARGET }])
    })
  })

  describe('MRC-11: pure support profiles never receive offensive actions', () => {
    it('returns no legal action when only basic attack is available', () => {
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          canAttack: false,
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK' }] }],
        }),
      )

      expect(evaluation.legalActions).toEqual([])
      expect(evaluation.resolve({ kind: 'END_TURN' })).toEqual({
        rotation: null,
        step: null,
        fallback: true,
        skipped: [{ rotation: 'HIGH', step: 1, reason: 'OFFENSIVE_ACTION_NOT_AVAILABLE' }],
      })
    })

    it('skips an offensive HIGH ability and offers a legal MEDIUM heal', () => {
      const golpe = directDamageAbility('golpe')
      const curar = healAbility('curar')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          canAttack: false,
          health: 50,
          abilities: [golpe, curar],
          rotations: [
            { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'golpe' }] },
            { priority: 'MEDIUM', steps: [{ kind: 'ABILITY', abilityId: 'curar' }] },
          ],
        }),
      )

      expect(evaluation.legalActions).toEqual([
        { kind: 'ABILITY', abilityId: 'curar', target: SELF_TARGET },
      ])
      expect(evaluation.resolve(evaluation.legalActions[0]!).skipped).toEqual([
        { rotation: 'HIGH', step: 1, reason: 'OFFENSIVE_ACTION_NOT_AVAILABLE' },
      ])
    })
  })
})
