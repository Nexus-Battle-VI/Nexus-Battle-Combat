import { evaluateEpicEffects } from '../../src/domain/policies/EpicSkillPolicy'
import type { CombatAbilityEffect } from '../../src/domain/entities/CombatProfile'

/**
 * `evaluateEpicEffects` (correccion HU-19/HU-31, tras GAP-HU31-CATALOG-MULTI-EFFECT): clasifica
 * TODOS los efectos de la epica (puede ser mas de uno simultaneo), a diferencia de
 * `evaluateSkill` (una habilidad se resuelve como UNA sola familia). Pura, sin sorteo.
 */
const fixed = (amount: number) => ({ mode: 'FIXED' as const, amount })
const statModifier = (overrides: Partial<CombatAbilityEffect> = {}): CombatAbilityEffect => ({
  kind: 'STAT_MODIFIER',
  target: 'SELF',
  statistic: 'ATTACK',
  operation: 'INCREASE',
  magnitude: fixed(2),
  hasActivationCondition: false,
  ...overrides,
})

const COOLDOWN = 2

describe('evaluateEpicEffects', () => {
  it('rechaza una lista vacia de efectos', () => {
    const support = evaluateEpicEffects([], COOLDOWN)

    expect(support).toEqual({ supported: false, reason: expect.stringContaining('ningun efecto') })
  })

  it('un unico STAT_MODIFIER SELF se clasifica como temporal con duracion = cooldownTurns', () => {
    const support = evaluateEpicEffects([statModifier()], COOLDOWN)

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.temporalStats).toEqual([
      {
        statistic: 'ATTACK',
        operation: 'INCREASE',
        audience: 'SELF',
        bonus: { fixed: 2, dice: [] },
        durationTurns: 2,
      },
    ])
    expect(support.plan.requiredAudience).toBeNull()
  })

  it('respeta durationTurns explicito en vez del cooldown de la epica', () => {
    const support = evaluateEpicEffects([statModifier({ durationTurns: 5 })], COOLDOWN)

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.temporalStats[0]?.durationTurns).toBe(5)
  })

  it('GAP-HU31-CATALOG-MULTI-EFFECT: varios efectos heterogeneos simultaneos (DAMAGE + CRITICAL_CHANCE)', () => {
    const support = evaluateEpicEffects(
      [
        statModifier({ statistic: 'DAMAGE' }),
        statModifier({ statistic: 'CRITICAL_CHANCE', magnitude: fixed(2) }),
      ],
      COOLDOWN,
    )

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.temporalStats).toHaveLength(2)
    expect(support.plan.temporalStats.map((e) => e.statistic)).toEqual([
      'DAMAGE',
      'CRITICAL_CHANCE',
    ])
  })

  it('POWER se registra igual que las demas (pendiente documentado: no consultado todavia)', () => {
    const support = evaluateEpicEffects(
      [statModifier({ statistic: 'POWER', operation: 'DECREASE', target: 'OPPONENT' })],
      COOLDOWN,
    )

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.temporalStats[0]).toMatchObject({
      statistic: 'POWER',
      operation: 'DECREASE',
      audience: 'OPPONENT',
    })
    expect(support.plan.requiredAudience).toBe('OPPONENT')
  })

  it('HEALING sin duracion -> sanacion instantanea (ALLY)', () => {
    const support = evaluateEpicEffects(
      [statModifier({ statistic: 'HEALING', target: 'ALLY', magnitude: fixed(6) })],
      COOLDOWN,
    )

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.instantHeals).toEqual([{ audience: 'ALLY', bonus: { fixed: 6, dice: [] } }])
    expect(support.plan.requiredAudience).toBe('ALLY')
  })

  it('HEALING con duracion -> temporal (tick en closeOwnTurn, no instantaneo)', () => {
    const support = evaluateEpicEffects(
      [
        statModifier({
          statistic: 'HEALING',
          target: 'ALLIED_GROUP',
          magnitude: fixed(4),
          durationTurns: 3,
        }),
      ],
      COOLDOWN,
    )

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.instantHeals).toEqual([])
    expect(support.plan.temporalStats).toEqual([
      {
        statistic: 'HEALING',
        operation: 'INCREASE',
        audience: 'ALLIED_GROUP',
        bonus: { fixed: 4, dice: [] },
        durationTurns: 3,
      },
    ])
    expect(support.plan.requiredAudience).toBe('ALLIED_GROUP')
  })

  it('DAMAGE directo sobre OPPONENT se clasifica como dano directo', () => {
    const effect: CombatAbilityEffect = {
      kind: 'DAMAGE',
      target: 'OPPONENT',
      magnitude: fixed(9),
      hasActivationCondition: false,
    }
    const support = evaluateEpicEffects([effect], COOLDOWN)

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.directDamage).toEqual([{ bonus: { fixed: 9, dice: [] } }])
    expect(support.plan.requiredAudience).toBe('OPPONENT')
  })

  it('REVIVE sobre ALLY con magnitud PERCENTAGE valida se clasifica como reanimacion', () => {
    const effect: CombatAbilityEffect = {
      kind: 'REVIVE',
      target: 'ALLY',
      magnitude: { mode: 'PERCENTAGE', basisPoints: 2000 },
      hasActivationCondition: false,
    }
    const support = evaluateEpicEffects([effect], COOLDOWN)

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.revives).toEqual([{ magnitude: { mode: 'PERCENTAGE', basisPoints: 2000 } }])
    expect(support.plan.requiredAudience).toBe('ALLY')
  })

  it('IMMUNITY sobre SELF se clasifica como temporal, duracion = cooldownTurns si no declara una propia', () => {
    const effect: CombatAbilityEffect = {
      kind: 'IMMUNITY',
      target: 'SELF',
      immunityCode: 'DAMAGE',
      hasActivationCondition: false,
    }
    const support = evaluateEpicEffects([effect], COOLDOWN)

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.immunities).toEqual([{ immunityCode: 'DAMAGE', durationTurns: 2 }])
    expect(support.plan.requiredAudience).toBeNull()
  })

  it.each([
    [
      'REFLECT_DAMAGE no soportado todavia',
      {
        kind: 'REFLECT_DAMAGE',
        target: 'OPPONENT',
        magnitude: { mode: 'PERCENTAGE' as const, basisPoints: 10_000 },
        hasActivationCondition: true,
      },
    ],
    [
      'TEMPORARY_STATUS no soportado todavia',
      {
        kind: 'TEMPORARY_STATUS',
        target: 'OPPONENT',
        statusCode: 'POISON',
        durationTurns: 2,
        hasActivationCondition: false,
      },
    ],
    ['kind desconocido', { kind: 'UNKNOWN_KIND', target: 'SELF', hasActivationCondition: false }],
  ])('%s: rechaza la epica ENTERA', (_label, effect) => {
    const support = evaluateEpicEffects([effect], COOLDOWN)

    expect(support.supported).toBe(false)
  })

  it('ENEMY_GROUP no soportado todavia', () => {
    const support = evaluateEpicEffects([statModifier({ target: 'ENEMY_GROUP' })], COOLDOWN)

    expect(support.supported).toBe(false)
  })

  it('un efecto condicionado (hasActivationCondition) se rechaza: la condicion no esta definida formalmente', () => {
    const support = evaluateEpicEffects([statModifier({ hasActivationCondition: true })], COOLDOWN)

    expect(support.supported).toBe(false)
  })

  it('una magnitud no usable (0, negativa, o ausente) se rechaza', () => {
    const support = evaluateEpicEffects([statModifier({ magnitude: fixed(0) })], COOLDOWN)

    expect(support.supported).toBe(false)
  })

  it('audiencias incompatibles entre dos efectos de la MISMA epica se rechazan (no se aplica a medias)', () => {
    const opponentDamage: CombatAbilityEffect = {
      kind: 'DAMAGE',
      target: 'OPPONENT',
      magnitude: fixed(5),
      hasActivationCondition: false,
    }
    const allyHeal = statModifier({ statistic: 'HEALING', target: 'ALLY', magnitude: fixed(3) })

    const support = evaluateEpicEffects([opponentDamage, allyHeal], COOLDOWN)

    expect(support).toEqual({
      supported: false,
      reason: expect.stringContaining('audiencias incompatibles'),
    })
  })

  it('heal + revive sobre el MISMO ALLY si se combinan (una sola audiencia)', () => {
    const heal = statModifier({ statistic: 'HEALING', target: 'ALLY', magnitude: fixed(3) })
    const revive: CombatAbilityEffect = {
      kind: 'REVIVE',
      target: 'ALLY',
      magnitude: { mode: 'PERCENTAGE', basisPoints: 1000 },
      hasActivationCondition: false,
    }

    const support = evaluateEpicEffects([heal, revive], COOLDOWN)

    expect(support.supported).toBe(true)
    if (!support.supported) throw new Error('inalcanzable')
    expect(support.plan.requiredAudience).toBe('ALLY')
  })

  it('un STAT_MODIFIER sobre ALLY/ALLIED_GROUP para ATTACK/DAMAGE/DEFENSE no esta definido', () => {
    const support = evaluateEpicEffects([statModifier({ target: 'ALLY' })], COOLDOWN)

    expect(support.supported).toBe(false)
  })

  it('DAMAGE directo sobre un objetivo distinto de OPPONENT no esta definido', () => {
    const effect: CombatAbilityEffect = {
      kind: 'DAMAGE',
      target: 'SELF',
      magnitude: fixed(9),
      hasActivationCondition: false,
    }
    expect(evaluateEpicEffects([effect], COOLDOWN).supported).toBe(false)
  })

  it('REVIVE con magnitud fuera de PERCENTAGE 1..10000 se rechaza', () => {
    const effect: CombatAbilityEffect = {
      kind: 'REVIVE',
      target: 'ALLY',
      magnitude: fixed(5),
      hasActivationCondition: false,
    }
    expect(evaluateEpicEffects([effect], COOLDOWN).supported).toBe(false)
  })

  it('IMMUNITY con magnitud declarada se rechaza (no lleva magnitud)', () => {
    const effect: CombatAbilityEffect = {
      kind: 'IMMUNITY',
      target: 'SELF',
      immunityCode: 'DAMAGE',
      magnitude: fixed(1),
      hasActivationCondition: false,
    }
    expect(evaluateEpicEffects([effect], COOLDOWN).supported).toBe(false)
  })

  it('IMMUNITY sin immunityCode se rechaza', () => {
    const effect: CombatAbilityEffect = {
      kind: 'IMMUNITY',
      target: 'SELF',
      hasActivationCondition: false,
    }
    expect(evaluateEpicEffects([effect], COOLDOWN).supported).toBe(false)
  })

  it('IMMUNITY sobre OPPONENT no esta definida', () => {
    const effect: CombatAbilityEffect = {
      kind: 'IMMUNITY',
      target: 'OPPONENT',
      immunityCode: 'DAMAGE',
      hasActivationCondition: false,
    }
    expect(evaluateEpicEffects([effect], COOLDOWN).supported).toBe(false)
  })
})
