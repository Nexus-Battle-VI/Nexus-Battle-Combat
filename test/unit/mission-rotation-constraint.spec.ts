import {
  MissionRotationConstraint,
  type MissionRotation,
} from '../../src/application/services/MissionRotationConstraint'
import type { CombatAbility } from '../../src/domain/entities/CombatProfile'

const TARGET = Object.freeze({
  scope: 'COMBATANT' as const,
  combatant: { teamLabel: 'ENEMY', seat: 0 },
})

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

const baseInput = (overrides: {
  readonly rotations: readonly MissionRotation[]
  readonly abilities?: readonly CombatAbility[]
  readonly cooldowns?: ReadonlyMap<string, number>
  readonly power?: number
  readonly health?: number
  readonly maxHealth?: number
  readonly cursors?: Map<number, number>
}) => ({
  rotations: overrides.rotations,
  cursors: overrides.cursors ?? new Map<number, number>(),
  abilities: new Map((overrides.abilities ?? []).map((a) => [a.abilityId, a])),
  cooldowns: overrides.cooldowns ?? new Map<string, number>(),
  power: overrides.power ?? 10,
  health: overrides.health ?? 100,
  maxHealth: overrides.maxHealth ?? 100,
  target: TARGET,
})

describe('MissionRotationConstraint (EN-035.3, HU-71)', () => {
  it('MRC-01: HIGH wins when its current step is viable', () => {
    const golpe = damageAbility('golpe')
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [golpe],
        rotations: [
          { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'golpe' }] },
          { priority: 'MEDIUM', steps: [{ kind: 'BASIC_ATTACK' }] },
        ],
      }),
    )

    expect(evaluation.legalActions).toEqual([
      { kind: 'ABILITY', abilityId: 'golpe', target: TARGET },
    ])
    expect(evaluation.strategy).toMatchObject({ rotation: 'HIGH', step: 1, fallback: false })
  })

  it('MRC-02: HIGH not viable (NOT_ENOUGH_POWER) falls through to MEDIUM, recording only HIGH as skipped', () => {
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
      { kind: 'ABILITY', abilityId: 'barata', target: TARGET },
    ])
    expect(evaluation.strategy.skipped).toEqual([
      { rotation: 'HIGH', step: 1, reason: 'NOT_ENOUGH_POWER' },
    ])
  })

  it('MRC-03: no viable rotation falls back to BASIC_ATTACK with fallback: true', () => {
    const cara = damageAbility('cara', 99)
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [cara],
        power: 1,
        rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'cara' }] }],
      }),
    )

    expect(evaluation.legalActions).toEqual([{ kind: 'BASIC_ATTACK', target: TARGET }])
    expect(evaluation.strategy).toMatchObject({ rotation: null, step: null, fallback: true })
  })

  it('MRC-04: an explicit BASIC_ATTACK step is always viable, regardless of power/cooldown', () => {
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        power: 0,
        rotations: [{ priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK' }] }],
      }),
    )

    expect(evaluation.legalActions).toEqual([{ kind: 'BASIC_ATTACK', target: TARGET }])
    expect(evaluation.strategy.fallback).toBe(false)
  })

  it('MRC-05: cursors only advance after commit(), and only for the winning rotation', () => {
    const golpe = damageAbility('golpe')
    const cursors = new Map<number, number>()
    const evaluation = new MissionRotationConstraint().evaluate(
      baseInput({
        abilities: [golpe],
        cursors,
        rotations: [
          {
            priority: 'HIGH',
            steps: [{ kind: 'ABILITY', abilityId: 'golpe' }, { kind: 'BASIC_ATTACK' }],
          },
          { priority: 'MEDIUM', steps: [{ kind: 'BASIC_ATTACK' }] },
        ],
      }),
    )

    expect(cursors.size).toBe(0)
    evaluation.commit()
    expect(cursors.get(0)).toBe(1)
    expect(cursors.has(1)).toBe(false)
  })

  it('MRC-06: a non-viable step keeps its rotation cursor (never advances on skip)', () => {
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

    evaluation.commit()
    expect(cursors.get(0)).toBe(0)
    expect(evaluation.strategy.skipped).toEqual([
      { rotation: 'HIGH', step: 1, reason: 'ON_COOLDOWN' },
    ])
  })

  it('MRC-07: skip reasons cover unknown ability and unsupported effect', () => {
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

    expect(unknown.strategy.skipped).toEqual([
      { rotation: 'HIGH', step: 1, reason: 'UNKNOWN_ABILITY' },
    ])
    expect(unsupportedResult.strategy.skipped).toEqual([
      { rotation: 'HIGH', step: 1, reason: 'UNSUPPORTED_EFFECT' },
    ])
  })

  describe('MRC-08: health eligibility for healing (ADR-023)', () => {
    it('healthRatio >= 0.90 (exactly 90%) excludes healing as a candidate', () => {
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

      expect(evaluation.strategy.skipped).toEqual([
        { rotation: 'HIGH', step: 1, reason: 'HEALTH_NOT_ELIGIBLE' },
      ])
      expect(evaluation.legalActions).toEqual([{ kind: 'BASIC_ATTACK', target: TARGET }])
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
        { kind: 'ABILITY', abilityId: 'curar', target: TARGET },
      ])
    })

    it('at full health (100 %) healing is excluded', () => {
      const curar = healAbility('curar')
      const evaluation = new MissionRotationConstraint().evaluate(
        baseInput({
          abilities: [curar],
          health: 100,
          maxHealth: 100,
          rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'curar' }] }],
        }),
      )

      expect(evaluation.strategy.skipped).toEqual([
        { rotation: 'HIGH', step: 1, reason: 'HEALTH_NOT_ELIGIBLE' },
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
        { kind: 'ABILITY', abilityId: 'golpe', target: TARGET },
      ])
    })
  })
})
