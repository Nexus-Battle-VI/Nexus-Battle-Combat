import type { EquippedHeroEffect } from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import {
  EquipmentEffectOutcome,
  PendingReason,
  assessEquipmentEffect,
  buildHeroEffectTable,
} from '../../src/application/use-cases/BuildHeroEffectTable'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { equippedHeroFixture } from '../fixtures/equipped-hero'

/**
 * HU-25 / HU-20: efectos del equipamiento dirigidos al OPONENTE. El documento
 * define dos, ambos permanentes y sin condicion:
 *
 *   Baculo de Permafrost (Mago Hielo):  «-1 al dano del oponente, -2 % de critico
 *                                        al ataque del oponente»          (Tabla 9)
 *   Vision borrosa (Picaro Veneno):     «-1 al ataque del oponente»       (Tabla 10)
 *
 * Se clasifican como `AFFECTS_ATTACKERS`: no cambian la tabla ni el Ataque del
 * portador, sino los del heroe que lo ataca (`prepareAttack`).
 */
const opponentCriticalDecrease = (
  change: Partial<EquippedHeroEffect> = {},
): EquippedHeroEffect => ({
  sourceProductId: 'a1b2c3d4-0000-4000-8000-000000000001',
  sourceProductReference: 'baculo-de-permafrost',
  kind: 'STAT_MODIFIER',
  target: 'OPPONENT',
  statistic: 'CRITICAL_CHANCE',
  operation: 'DECREASE',
  magnitude: { mode: 'PERCENTAGE', basisPoints: 200 },
  hasActivationCondition: false,
  appliedToStats: false,
  ...change,
})

const opponentAttackDecrease = (change: Partial<EquippedHeroEffect> = {}): EquippedHeroEffect => ({
  sourceProductId: 'a1b2c3d4-0000-4000-8000-000000000002',
  sourceProductReference: 'vision-borrosa',
  kind: 'STAT_MODIFIER',
  target: 'OPPONENT',
  statistic: 'ATTACK',
  operation: 'DECREASE',
  magnitude: { mode: 'FIXED', amount: 1 },
  hasActivationCondition: false,
  appliedToStats: false,
  ...change,
})

describe('CRITICAL_CHANCE DECREASE sobre el oponente (-2 % de critico al ataque del oponente)', () => {
  it('permanente, incondicional y PERCENTAGE: AFFECTS_ATTACKERS con la reduccion en filas', () => {
    const assessment = assessEquipmentEffect(opponentCriticalDecrease())

    expect(assessment.outcome).toBe(EquipmentEffectOutcome.AffectsAttackers)
    expect(assessment.reasons).toEqual([])
    expect(assessment.modifier).toBeUndefined()
    expect(assessment.adjustment?.statistic).toBe('CRITICAL_CHANCE')

    if (assessment.adjustment?.statistic === 'CRITICAL_CHANCE') {
      // 200 pb = 2 puntos porcentuales absolutos = 160 filas, igual que el +3 % del propio equipo.
      expect(assessment.adjustment.reduction.effect).toBe(RandomEffectType.CriticalDamage)
      expect(assessment.adjustment.reduction.rows).toBe(160)
    }
  })

  it.each([
    [100, 80],
    [200, 160],
    [300, 240],
    [600, 480],
    [5, 4],
  ])('%i pb reducen %i filas', (basisPoints, rows) => {
    const assessment = assessEquipmentEffect(
      opponentCriticalDecrease({ magnitude: { mode: 'PERCENTAGE', basisPoints } }),
    )

    expect(assessment.adjustment).toMatchObject({ statistic: 'CRITICAL_CHANCE' })
    expect(
      assessment.adjustment?.statistic === 'CRITICAL_CHANCE' &&
        assessment.adjustment.reduction.rows,
    ).toBe(rows)
  })

  it.each([
    [
      'con condicion de activacion',
      { hasActivationCondition: true },
      [PendingReason.ActivationConditionUnevaluated],
    ],
    ['temporal', { durationTurns: 2 }, [PendingReason.TemporaryEffectUndefined]],
    [
      'puntos basicos sin filas exactas (203)',
      { magnitude: { mode: 'PERCENTAGE', basisPoints: 203 } as const },
      [PendingReason.CriticalChanceNotRowAligned],
    ],
    [
      'magnitud FIXED',
      { magnitude: { mode: 'FIXED', amount: 2 } as const },
      [PendingReason.CriticalChanceUnitUndefined],
    ],
    [
      'marcado appliedToStats (contradice el contrato)',
      { appliedToStats: true },
      [PendingReason.CriticalChanceAlreadyInStatsInconsistent],
    ],
  ] satisfies readonly (readonly [
    string,
    Partial<EquippedHeroEffect>,
    readonly PendingReason[],
  ])[])('%s: queda PENDIENTE y no se aplica', (_label, change, reasons) => {
    const assessment = assessEquipmentEffect(opponentCriticalDecrease(change))

    expect(assessment.outcome).toBe(EquipmentEffectOutcome.PendingDefinition)
    expect(assessment.reasons).toEqual(reasons)
    expect(assessment.adjustment).toBeUndefined()
  })

  it('la combinacion objetivo/operacion que el documento NO define sigue pendiente', () => {
    // INCREASE contra el oponente (un bonus al rival) no existe en el documento.
    expect(
      assessEquipmentEffect(opponentCriticalDecrease({ operation: 'INCREASE' })).reasons,
    ).toEqual([PendingReason.NonSelfTargetUndefined])
    // DECREASE sobre uno mismo (un auto-castigo) tampoco.
    expect(assessEquipmentEffect(opponentCriticalDecrease({ target: 'SELF' })).reasons).toEqual([
      PendingReason.OperationUndefined,
    ])
    // Otros objetivos: ni el objetivo ni la operacion estan definidos.
    expect(assessEquipmentEffect(opponentCriticalDecrease({ target: 'ALLY' })).reasons).toEqual([
      PendingReason.NonSelfTargetUndefined,
      PendingReason.OperationUndefined,
    ])
    expect(assessEquipmentEffect(opponentCriticalDecrease({ target: 'ENEMY_GROUP' })).outcome).toBe(
      EquipmentEffectOutcome.PendingDefinition,
    )
    // Contra el oponente solo se define la DISMINUCION: cualquier otra operacion no.
    expect(assessEquipmentEffect(opponentCriticalDecrease({ operation: 'SET' })).reasons).toEqual([
      PendingReason.NonSelfTargetUndefined,
      PendingReason.OperationUndefined,
    ])
  })

  it('el incremento sobre uno mismo sigue siendo APPLIED_TO_TABLE, no AFFECTS_ATTACKERS', () => {
    const own = assessEquipmentEffect(
      opponentCriticalDecrease({ target: 'SELF', operation: 'INCREASE' }),
    )

    expect(own.outcome).toBe(EquipmentEffectOutcome.AppliedToTable)
    expect(own.adjustment).toBeUndefined()
    expect(own.modifier?.rows).toBe(160)
  })
})

describe('ATTACK DECREASE FIXED sobre el oponente (-1 al ataque del oponente)', () => {
  it('permanente, incondicional y FIXED: AFFECTS_ATTACKERS con los puntos que resta', () => {
    const assessment = assessEquipmentEffect(opponentAttackDecrease())

    expect(assessment).toMatchObject({
      outcome: EquipmentEffectOutcome.AffectsAttackers,
      reasons: [],
      adjustment: { statistic: 'ATTACK', points: 1 },
    })
    expect(assessment.modifier).toBeUndefined()
  })

  it.each([0, 1, 2, 5])('resta %i puntos', (amount) => {
    expect(
      assessEquipmentEffect(opponentAttackDecrease({ magnitude: { mode: 'FIXED', amount } }))
        .adjustment,
    ).toEqual({ statistic: 'ATTACK', points: amount })
  })

  it.each([
    ['un decimal (1.5)', { magnitude: { mode: 'FIXED', amount: 1.5 } as const }],
    ['un negativo (-1)', { magnitude: { mode: 'FIXED', amount: -1 } as const }],
    [
      'un porcentaje: necesitaria la base de OTRO heroe',
      { magnitude: { mode: 'PERCENTAGE', basisPoints: 1000 } as const },
    ],
    ['un dado: no es un valor', { magnitude: { mode: 'DICE', count: 1, sides: 4 } as const }],
    ['un aumento del Ataque del oponente', { operation: 'INCREASE' }],
    ['otra operacion (SET)', { operation: 'SET' }],
  ] satisfies readonly (readonly [string, Partial<EquippedHeroEffect>])[])(
    '%s: PENDIENTE (OPPONENT_STAT_EFFECT_UNDEFINED), no se aplica',
    (_label, change) => {
      const assessment = assessEquipmentEffect(opponentAttackDecrease(change))

      expect(assessment.outcome).toBe(EquipmentEffectOutcome.PendingDefinition)
      expect(assessment.reasons).toEqual([PendingReason.OpponentStatEffectUndefined])
      expect(assessment.adjustment).toBeUndefined()
    },
  )

  it('con condicion de activacion: pendiente aunque la forma sea la definida', () => {
    const assessment = assessEquipmentEffect(
      opponentAttackDecrease({ hasActivationCondition: true }),
    )

    expect(assessment.outcome).toBe(EquipmentEffectOutcome.PendingDefinition)
    expect(assessment.reasons).toEqual([PendingReason.ActivationConditionUnevaluated])
  })

  it('temporal: pendiente aunque la forma sea la definida', () => {
    const assessment = assessEquipmentEffect(opponentAttackDecrease({ durationTurns: 2 }))

    expect(assessment.outcome).toBe(EquipmentEffectOutcome.PendingDefinition)
    expect(assessment.reasons).toEqual([PendingReason.TemporaryEffectUndefined])
  })

  it('una forma no definida ademas condicionada y temporal lista TODOS los motivos', () => {
    const assessment = assessEquipmentEffect(
      opponentAttackDecrease({
        magnitude: { mode: 'PERCENTAGE', basisPoints: 500 },
        hasActivationCondition: true,
        durationTurns: 3,
      }),
    )

    expect(assessment.reasons).toEqual([
      PendingReason.OpponentStatEffectUndefined,
      PendingReason.ActivationConditionUnevaluated,
      PendingReason.TemporaryEffectUndefined,
    ])
  })

  it('ya consolidado (appliedToStats) se ignora como reflejado, sin volver a restarse', () => {
    expect(assessEquipmentEffect(opponentAttackDecrease({ appliedToStats: true })).outcome).toBe(
      EquipmentEffectOutcome.ReflectedInStats,
    )
  })

  it('sobre uno mismo (SELF) no es de este caso: Player-Inventory ya lo consolido en effectiveStats', () => {
    expect(
      assessEquipmentEffect(opponentAttackDecrease({ target: 'SELF', appliedToStats: true }))
        .outcome,
    ).toBe(EquipmentEffectOutcome.ReflectedInStats)
  })
})

describe('otros efectos dirigidos al oponente', () => {
  it('DEFENSE sobre el oponente: el documento no define ninguno; queda pendiente, no silenciado', () => {
    const assessment = assessEquipmentEffect(
      opponentAttackDecrease({ statistic: 'DEFENSE', sourceProductReference: 'x' }),
    )

    expect(assessment.outcome).toBe(EquipmentEffectOutcome.PendingDefinition)
    expect(assessment.reasons).toEqual([PendingReason.OpponentStatEffectUndefined])
  })

  it('«-1 al dano del oponente» (DAMAGE) no es del ataque: es dano numerico (HU-18), no un modificador de la tabla', () => {
    const assessment = assessEquipmentEffect(
      opponentAttackDecrease({
        statistic: 'DAMAGE',
        sourceProductReference: 'baculo-de-permafrost',
      }),
    )

    expect(assessment.outcome).toBe(EquipmentEffectOutcome.NotATableModifier)
  })

  it('un efecto de kind DAMAGE dirigido al oponente sigue siendo ajeno a la tabla', () => {
    expect(
      assessEquipmentEffect({
        sourceProductId: 'a1b2c3d4-0000-4000-8000-000000000003',
        sourceProductReference: 'daga-envenenada',
        kind: 'DAMAGE',
        target: 'OPPONENT',
        magnitude: { mode: 'DICE', count: 1, sides: 6 },
        hasActivationCondition: false,
        appliedToStats: false,
      }).outcome,
    ).toBe(EquipmentEffectOutcome.NotATableModifier)
  })
})

describe('buildHeroEffectTable: los efectos del portador que alteran a sus atacantes', () => {
  const magoHielo = (activeEffects: readonly EquippedHeroEffect[]) =>
    buildHeroEffectTable(equippedHeroFixture({ subtype: 'MAGO_HIELO', activeEffects }))

  it('van a opponentEffects y NO cambian la tabla del propio portador', () => {
    const own = magoHielo([])
    const withStaff = magoHielo([opponentCriticalDecrease(), opponentAttackDecrease()])

    expect(withStaff.opponentEffects).toHaveLength(2)
    expect(withStaff.opponentEffects.map(({ outcome }) => outcome)).toEqual([
      EquipmentEffectOutcome.AffectsAttackers,
      EquipmentEffectOutcome.AffectsAttackers,
    ])
    expect(withStaff.table.ranges).toEqual(own.table.ranges)
    expect(withStaff.appliedEffects).toEqual([])
    expect(withStaff.pendingEffects).toEqual([])
  })

  it('un efecto propio y uno dirigido al oponente conviven: cada uno va a su sitio', () => {
    const own = {
      ...opponentCriticalDecrease({ target: 'SELF', operation: 'INCREASE' }),
      sourceProductReference: 'orbe',
    }
    const built = magoHielo([own, opponentCriticalDecrease()])

    expect(built.appliedEffects).toHaveLength(1)
    expect(built.opponentEffects).toHaveLength(1)
    expect(built.table.rowsOf(RandomEffectType.CriticalDamage)).toBe(480 + 160)
  })

  it('sin efectos, opponentEffects esta vacio', () => {
    expect(magoHielo([]).opponentEffects).toEqual([])
  })
})
