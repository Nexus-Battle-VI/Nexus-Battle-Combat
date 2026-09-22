import 'reflect-metadata'

import { PlayerInventoryHttpClient } from '../../src/adapters/outbound/http/PlayerInventoryHttpClient'
import {
  PlayerWithoutEquippedHeroError,
  UpstreamServiceError,
} from '../../src/application/errors/UpstreamErrors'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  EquippedHero,
  EquippedHeroEffect,
  PlayerInventoryEquippedHeroPort,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import {
  BuildHeroEffectTable,
  EquipmentEffectOutcome,
  PendingReason,
  assessEquipmentEffect,
  buildHeroEffectTable,
} from '../../src/application/use-cases/BuildHeroEffectTable'
import { ResolveRandomEffect } from '../../src/application/use-cases/ResolveRandomEffect'
import { DomainError } from '../../src/domain/errors/DomainError'
import { InsufficientNoDamageProbabilityError } from '../../src/domain/errors/RandomEffectErrors'
import {
  BASE_EFFECT_PERCENTAGES,
  ROWS_PER_PERCENT,
  baseEffectTableFor,
} from '../../src/domain/random-effects/BaseEffectProfiles'
import type { EffectControlTable } from '../../src/domain/random-effects/EffectControlTable'
import { ProbabilityModifier } from '../../src/domain/random-effects/ProbabilityModifier'
import {
  RANDOM_EFFECT_ORDER,
  RandomEffectType,
} from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import type { Logger } from '../../src/infrastructure/observability/logger'
import {
  attackBonusEffect,
  conditionalDefenseEffect,
  criticalChancePercentageEffect,
  equippedHeroContractBody,
  equippedHeroFixture,
  opponentDamageDiceEffect,
} from '../fixtures/equipped-hero'

/**
 * HU-25, integracion con Player-Inventory: del heroe equipado real a la tabla
 * vigente. `playerId -> heroe -> subtype -> tabla base -> activeEffects ->
 * modificadores -> tabla vigente`.
 *
 * LO QUE ESTAS PRUEBAS FIJAN:
 *  - La tabla se elige por el subtipo REAL del heroe (Tablas 21/22).
 *  - `CRITICAL_CHANCE INCREASE PERCENTAGE` incondicional, permanente y sobre
 *    SELF modifica la tabla: los puntos basicos son PUNTOS PORCENTUALES
 *    ABSOLUTOS (100 pb = +1 pp = +80 filas; Tabla 23: 5 % + 6 % = 11 %). Regla
 *    LOCAL a la tabla de HU-25: no redefine `PERCENTAGE` para otras
 *    estadisticas.
 *  - Todo otro efecto (DECREASE, SET, FIXED, DICE, condicionado, temporal,
 *    hacia otro objetivo...) se CLASIFICA y queda declarado, sin tocar la tabla.
 */

const rowsOfTable = (table: EffectControlTable): Record<string, number> =>
  Object.fromEntries(RANDOM_EFFECT_ORDER.map((effect) => [effect, table.rowsOf(effect)]))

const effect = (change: Partial<EquippedHeroEffect>): EquippedHeroEffect => ({
  ...criticalChancePercentageEffect,
  ...change,
})

/** Efecto sin la clave (los opcionales se AUSENTAN, no vienen a `undefined`). */
const withoutKeys = (
  source: EquippedHeroEffect,
  ...keys: readonly (keyof EquippedHeroEffect)[]
): EquippedHeroEffect => {
  const removed: readonly string[] = keys

  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !removed.includes(key)),
  ) as unknown as EquippedHeroEffect
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }

  return value
}

describe('buildHeroEffectTable — subtype real -> tabla base (HU-25)', () => {
  const SUPPORTED = [
    HeroSubtype.GuerreroTanque,
    HeroSubtype.GuerreroArmas,
    HeroSubtype.MagoFuego,
    HeroSubtype.MagoHielo,
    HeroSubtype.PicaroVeneno,
    HeroSubtype.PicaroMachete,
  ] as const

  it.each(SUPPORTED)(
    '%s: las filas de cada efecto son la Tabla 21 x 80 filas por punto',
    (subtype) => {
      const { table } = buildHeroEffectTable(equippedHeroFixture({ subtype, activeEffects: [] }))
      const porcentajes = BASE_EFFECT_PERCENTAGES[subtype]

      expect(rowsOfTable(table)).toEqual(
        Object.fromEntries(
          RANDOM_EFFECT_ORDER.map((efecto) => [efecto, porcentajes[efecto] * ROWS_PER_PERCENT]),
        ),
      )
    },
  )

  it('GUERRERO_ARMAS -> Tabla 22 exacta (1-4800 / 4801-5200 / 5201-5440 / 5441-5600 / 5601-8000)', () => {
    const { table, subtype } = buildHeroEffectTable(
      equippedHeroFixture({ subtype: 'GUERRERO_ARMAS', activeEffects: [] }),
    )

    expect(subtype).toBe(HeroSubtype.GuerreroArmas)
    expect(table.ranges).toEqual([
      { effect: RandomEffectType.Damage, firstRow: 1, lastRow: 4800 },
      { effect: RandomEffectType.CriticalDamage, firstRow: 4801, lastRow: 5200 },
      { effect: RandomEffectType.Evade, firstRow: 5201, lastRow: 5440 },
      { effect: RandomEffectType.Escape, firstRow: 5441, lastRow: 5600 },
      { effect: RandomEffectType.NoDamage, firstRow: 5601, lastRow: 8000 },
    ])
  })

  it('MAGO_FUEGO -> su configuracion (Resiste 5 %, sin Evade ni Escape)', () => {
    const { table } = buildHeroEffectTable(
      equippedHeroFixture({ subtype: 'MAGO_FUEGO', activeEffects: [] }),
    )

    expect(table.ranges).toEqual([
      { effect: RandomEffectType.Damage, firstRow: 1, lastRow: 5600 },
      { effect: RandomEffectType.CriticalDamage, firstRow: 5601, lastRow: 6000 },
      { effect: RandomEffectType.Resist, firstRow: 6001, lastRow: 6400 },
      { effect: RandomEffectType.NoDamage, firstRow: 6401, lastRow: 8000 },
    ])
  })

  it('PICARO_MACHETE -> su configuracion (Critico 8 %, Escape 2 %)', () => {
    const { table } = buildHeroEffectTable(
      equippedHeroFixture({ subtype: 'PICARO_MACHETE', activeEffects: [] }),
    )

    expect(table.ranges).toEqual([
      { effect: RandomEffectType.Damage, firstRow: 1, lastRow: 4800 },
      { effect: RandomEffectType.CriticalDamage, firstRow: 4801, lastRow: 5440 },
      { effect: RandomEffectType.Escape, firstRow: 5441, lastRow: 5600 },
      { effect: RandomEffectType.NoDamage, firstRow: 5601, lastRow: 8000 },
    ])
  })

  it('la tabla depende del heroe: el mismo indice resuelve efectos distintos segun el subtipo real', () => {
    const resolve = (subtype: string): RandomEffectType => {
      const { table } = buildHeroEffectTable(equippedHeroFixture({ subtype, activeEffects: [] }))
      const sequence: RandomSequencePort = { nextIndex: () => RandomIndex.create(3400) }

      return new ResolveRandomEffect().execute({ sequence, table }).effect
    }

    // Fila 3400: Armas -> DAMAGE (1-4800). Tanque -> EVADE (3201-3600).
    expect(resolve('GUERRERO_ARMAS')).toBe(RandomEffectType.Damage)
    expect(resolve('GUERRERO_TANQUE')).toBe(RandomEffectType.Evade)
  })

  it.each([HeroSubtype.Chaman, HeroSubtype.Medico])(
    '%s -> tabla de sanadores: 8000 filas de «no causar dano» (decision de diseno del documento)',
    (subtype) => {
      const { table } = buildHeroEffectTable(equippedHeroFixture({ subtype, activeEffects: [] }))

      expect(rowsOfTable(table)).toEqual({
        DAMAGE: 0,
        CRITICAL_DAMAGE: 0,
        EVADE: 0,
        RESIST: 0,
        ESCAPE: 0,
        NO_DAMAGE: 8000,
      })
    },
  )

  it.each(['GUERRERO', 'guerrero_armas', ' GUERRERO_ARMAS', 'HEROE_NUEVO', ''])(
    'subtipo fuera del registro hero-subtypes-v1 (%p) -> DomainError, sin adivinar por parecido',
    (subtype) => {
      expect(() => buildHeroEffectTable(equippedHeroFixture({ subtype }))).toThrow(DomainError)
    },
  )

  it('devuelve el heroId y el subtipo ya validado', () => {
    const result = buildHeroEffectTable(equippedHeroFixture({ heroId: 'heroe-42' }))

    expect(result.heroId).toBe('heroe-42')
    expect(result.subtype).toBe(HeroSubtype.GuerreroArmas)
  })
})

describe('buildHeroEffectTable — CRITICAL_CHANCE INCREASE PERCENTAGE modifica la tabla (HU-25)', () => {
  const base = baseEffectTableFor(HeroSubtype.GuerreroArmas)
  const critico = (basisPoints: number, change: Partial<EquippedHeroEffect> = {}) =>
    effect({ magnitude: { mode: 'PERCENTAGE', basisPoints }, ...change })
  const build = (...activeEffects: EquippedHeroEffect[]) =>
    buildHeroEffectTable(equippedHeroFixture({ activeEffects }))

  it('sin activeEffects la tabla vigente es la base', () => {
    const { table, appliedEffects, pendingEffects } = build()

    expect(table.ranges).toEqual(base.ranges)
    expect(appliedEffects).toEqual([])
    expect(pendingEffects).toEqual([])
  })

  it('la espada de dos manos (300 pb) suma +3 puntos: critico 400 -> 640 filas', () => {
    const { table } = build(criticalChancePercentageEffect)

    expect(base.rowsOf(RandomEffectType.CriticalDamage)).toBe(400)
    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(640)
  })

  it('300 pb restan 240 filas de NO_DAMAGE: 2400 -> 2160', () => {
    const { table } = build(criticalChancePercentageEffect)

    expect(base.rowsOf(RandomEffectType.NoDamage)).toBe(2400)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(2160)
  })

  it('el resto de efectos conserva sus filas y el total sigue siendo 8000', () => {
    const { table } = build(criticalChancePercentageEffect)

    expect(rowsOfTable(table)).toEqual({
      DAMAGE: 4800,
      CRITICAL_DAMAGE: 640,
      EVADE: 240,
      RESIST: 0,
      ESCAPE: 160,
      NO_DAMAGE: 2160,
    })
    expect(Object.values(rowsOfTable(table)).reduce((a, b) => a + b, 0)).toBe(8000)
  })

  it('rangos exactos del caso +300 pb (critico 8 %, sin dano 27 %)', () => {
    const { table } = build(criticalChancePercentageEffect)

    expect(table.ranges).toEqual([
      { effect: RandomEffectType.Damage, firstRow: 1, lastRow: 4800 },
      { effect: RandomEffectType.CriticalDamage, firstRow: 4801, lastRow: 5440 },
      { effect: RandomEffectType.Evade, firstRow: 5441, lastRow: 5680 },
      { effect: RandomEffectType.Escape, firstRow: 5681, lastRow: 5840 },
      { effect: RandomEffectType.NoDamage, firstRow: 5841, lastRow: 8000 },
    ])
  })

  it.each([
    [4800, RandomEffectType.Damage],
    [4801, RandomEffectType.CriticalDamage],
    [5440, RandomEffectType.CriticalDamage],
    [5441, RandomEffectType.Evade],
    [5680, RandomEffectType.Evade],
    [5681, RandomEffectType.Escape],
    [5840, RandomEffectType.Escape],
    [5841, RandomEffectType.NoDamage],
    [8000, RandomEffectType.NoDamage],
  ])('fronteras +300 pb: la fila %i resuelve %s', (row, expected) => {
    const { table } = build(criticalChancePercentageEffect)

    expect(table.resolve(RandomIndex.create(row)).effect).toBe(expected)
  })

  it('600 pb (el +6 % de la Tabla 23) reproduce la Tabla 23 EXACTA: critico 11 %, sin dano 24 %', () => {
    const { table } = build(critico(600))

    expect(table.ranges).toEqual([
      { effect: RandomEffectType.Damage, firstRow: 1, lastRow: 4800 },
      { effect: RandomEffectType.CriticalDamage, firstRow: 4801, lastRow: 5680 },
      { effect: RandomEffectType.Evade, firstRow: 5681, lastRow: 5920 },
      { effect: RandomEffectType.Escape, firstRow: 5921, lastRow: 6080 },
      { effect: RandomEffectType.NoDamage, firstRow: 6081, lastRow: 8000 },
    ])
    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(880)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(1920)
    expect(table.rowsOf(RandomEffectType.Resist)).toBe(0)
  })

  it('el resultado por el heroe coincide con el ProbabilityModifier del dominio (fuente unica de la conversion)', () => {
    const esperada = base.withModifiers([
      ProbabilityModifier.ofBasisPoints(RandomEffectType.CriticalDamage, 300),
    ])

    expect(build(criticalChancePercentageEffect).table.ranges).toEqual(esperada.ranges)
  })

  it.each([
    ['100 pb', 100, 80],
    ['300 pb', 300, 240],
    ['600 pb', 600, 480],
    ['5 pb (el minimo exacto)', 5, 4],
  ])('%s = +%i filas de critico', (_label, basisPoints, rows) => {
    const { table } = build(critico(basisPoints))

    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(400 + rows)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(2400 - rows)
  })

  it('varios bonos validos se suman (+300 +200 = +5 puntos = 800 filas) y salen de NO_DAMAGE', () => {
    const { table, appliedEffects } = build(critico(300), critico(200))

    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(800)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(2000)
    expect(appliedEffects).toHaveLength(2)
  })

  it('el orden no importa: +200 +300 da la misma tabla que +300 +200', () => {
    const uno = build(critico(300), critico(200)).table
    const otro = build(critico(200), critico(300)).table

    expect(otro.ranges).toEqual(uno.ranges)
  })

  it('un bono de 0 pb se aplica sin cambiar la tabla', () => {
    const { table, appliedEffects, pendingEffects } = build(critico(0))

    expect(table.ranges).toEqual(base.ranges)
    expect(appliedEffects).toHaveLength(1)
    expect(pendingEffects).toEqual([])
  })

  it('un bono que consume EXACTAMENTE el NO_DAMAGE disponible es valido (queda en 0)', () => {
    // 2400 filas de NO_DAMAGE = 30 % = 3000 pb.
    const { table } = build(critico(3000))

    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(0)
    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(2800)
    expect(table.resolve(RandomIndex.create(8000)).effect).toBe(RandomEffectType.Escape)
  })

  it('un bono mayor que el NO_DAMAGE disponible falla: no se recorta ni se redistribuye', () => {
    expect(() => build(critico(3005))).toThrow(InsufficientNoDamageProbabilityError)
    expect(() => build(critico(2000), critico(1500))).toThrow(InsufficientNoDamageProbabilityError)
    expect(() => build(critico(10_000))).toThrow(InsufficientNoDamageProbabilityError)
  })

  it('el efecto aplicado NO es pendiente: sale como APPLIED_TO_TABLE con su modificador', () => {
    const { assessments, appliedEffects, pendingEffects } = build(criticalChancePercentageEffect)

    expect(pendingEffects).toEqual([])
    expect(assessments).toHaveLength(1)
    expect(appliedEffects).toHaveLength(1)
    expect(appliedEffects[0]?.outcome).toBe(EquipmentEffectOutcome.AppliedToTable)
    expect(appliedEffects[0]?.reasons).toEqual([])
    expect(appliedEffects[0]?.effect).toBe(criticalChancePercentageEffect)
    expect(appliedEffects[0]?.modifier).toEqual(
      ProbabilityModifier.ofBasisPoints(RandomEffectType.CriticalDamage, 300),
    )
  })

  it('un efecto se aplica UNA sola vez: con dos bonos de 300 pb el critico gana 480 filas, no 720', () => {
    const { table } = build(critico(300), critico(300, { sourceProductReference: 'anillo' }))

    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(400 + 480)
  })

  it('no toca la tabla base compartida, BASE_EFFECT_PERCENTAGES ni activeEffects, y es determinista', () => {
    const antes = JSON.stringify(BASE_EFFECT_PERCENTAGES)
    const efectos = deepFreeze([critico(300), critico(200)])
    const hero = deepFreeze(equippedHeroFixture({ activeEffects: efectos }))

    const primera = buildHeroEffectTable(hero)
    const segunda = buildHeroEffectTable(hero)

    expect(primera.table.ranges).toEqual(segunda.table.ranges)
    expect(primera.table).not.toBe(base)
    expect(baseEffectTableFor(HeroSubtype.GuerreroArmas).ranges).toEqual(base.ranges)
    expect(base.rowsOf(RandomEffectType.CriticalDamage)).toBe(400)
    expect(JSON.stringify(BASE_EFFECT_PERCENTAGES)).toBe(antes)
  })

  it.each([
    ['con condicion de activacion', { hasActivationCondition: true }],
    ['dirigido a otro objetivo', { target: 'OPPONENT' }],
    ['temporal (durationTurns)', { durationTurns: 3 }],
    ['operacion DECREASE', { operation: 'DECREASE' }],
    ['operacion SET', { operation: 'SET' }],
    ['operacion MULTIPLY', { operation: 'MULTIPLY' }],
    ['operacion BLOCK', { operation: 'BLOCK' }],
    ['magnitud FIXED', { magnitude: { mode: 'FIXED', amount: 3 } as const }],
    ['magnitud DICE', { magnitude: { mode: 'DICE', count: 1, sides: 6 } as const }],
    [
      'appliedToStats=true (contradice el contrato: effectiveStats no tiene critico)',
      { appliedToStats: true },
    ],
  ] satisfies readonly (readonly [string, Partial<EquippedHeroEffect>])[])(
    'CRITICAL_CHANCE %s: PENDING_DEFINITION y la tabla NO cambia',
    (_label, change) => {
      const { table, pendingEffects, appliedEffects } = build(effect(change))

      expect(table.ranges).toEqual(base.ranges)
      expect(appliedEffects).toEqual([])
      expect(pendingEffects).toHaveLength(1)
      expect(pendingEffects[0]?.outcome).toBe(EquipmentEffectOutcome.PendingDefinition)
      expect(pendingEffects[0]?.reasons.length).toBeGreaterThan(0)
      expect(pendingEffects[0]?.modifier).toBeUndefined()
    },
  )

  it('un efecto pendiente no impide aplicar los validos: solo los validos suman', () => {
    const { table, appliedEffects, pendingEffects } = build(
      critico(300),
      critico(300, { hasActivationCondition: true }),
      critico(200, { target: 'OPPONENT' }),
    )

    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(640)
    expect(appliedEffects).toHaveLength(1)
    expect(pendingEffects).toHaveLength(2)
  })

  it.each([
    ['sin multiplo de 5 pb (303)', 303],
    ['no entero (2.5)', 2.5],
    ['negativo (-300)', -300],
  ])(
    'PERCENTAGE %s no equivale a filas exactas: pendiente, no se redondea',
    (_label, basisPoints) => {
      const { table, pendingEffects } = build(critico(basisPoints))

      expect(table.ranges).toEqual(base.ranges)
      expect(pendingEffects[0]?.reasons).toEqual([PendingReason.CriticalChanceNotRowAligned])
    },
  )

  it('MAGO_FUEGO (sin Evade ni Escape): el critico sigue saliendo de NO_DAMAGE', () => {
    const { table } = buildHeroEffectTable(
      equippedHeroFixture({ subtype: 'MAGO_FUEGO', activeEffects: [critico(300)] }),
    )

    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(400 + 240)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(1600 - 240)
  })

  it('una estadistica que NO es critico con PERCENTAGE sigue sin ser una probabilidad de la tabla (regla local)', () => {
    const ataque = effect({
      statistic: 'ATTACK',
      magnitude: { mode: 'PERCENTAGE', basisPoints: 300 },
    })
    const { table, appliedEffects, nonTableEffects } = build(ataque)

    expect(table.ranges).toEqual(base.ranges)
    expect(appliedEffects).toEqual([])
    expect(nonTableEffects).toHaveLength(1)
  })
})

describe('assessEquipmentEffect — que se hace con cada efecto (HU-25)', () => {
  it('appliedToStats=true -> REFLECTED_IN_STATS: no se vuelve a aplicar, y no es pendiente', () => {
    expect(assessEquipmentEffect(attackBonusEffect)).toEqual({
      effect: attackBonusEffect,
      outcome: EquipmentEffectOutcome.ReflectedInStats,
      reasons: [],
    })
  })

  it('no vuelve a sumar un efecto ya consolidado: el heroe (con su ataque efectivo) no cambia', () => {
    const hero = deepFreeze(
      equippedHeroFixture({ activeEffects: [attackBonusEffect], subtype: 'GUERRERO_ARMAS' }),
    )

    const { table, assessments } = buildHeroEffectTable(hero)

    // 10 (base) + 3 (espada) = 13 ya en effectiveStats. Nada lo toca.
    expect(hero.effectiveStats.attack).toBe(13)
    expect(hero.baseStats.attack).toBe(10)
    expect(assessments[0]?.outcome).toBe(EquipmentEffectOutcome.ReflectedInStats)
    expect(table.ranges).toEqual(baseEffectTableFor(HeroSubtype.GuerreroArmas).ranges)
  })

  it('efecto condicionado sobre una estadistica numerica -> no es un modificador de la tabla y NO se aplica como permanente', () => {
    expect(assessEquipmentEffect(conditionalDefenseEffect)).toEqual({
      effect: conditionalDefenseEffect,
      outcome: EquipmentEffectOutcome.NotATableModifier,
      reasons: [],
    })
  })

  it('efecto de dano al oponente con dados -> no es un modificador de la tabla', () => {
    expect(assessEquipmentEffect(opponentDamageDiceEffect).outcome).toBe(
      EquipmentEffectOutcome.NotATableModifier,
    )
  })

  it.each(['POWER', 'HEALTH', 'DEFENSE', 'ATTACK', 'DAMAGE', 'HEALING'])(
    'STAT_MODIFIER sobre %s (no consolidado) -> NOT_A_TABLE_MODIFIER',
    (statistic) => {
      expect(
        assessEquipmentEffect(effect({ statistic, magnitude: { mode: 'FIXED', amount: 1 } }))
          .outcome,
      ).toBe(EquipmentEffectOutcome.NotATableModifier)
    },
  )

  it.each(['DAMAGE', 'HEALING', 'IMMUNITY', 'REFLECT_DAMAGE', 'REVIVE', 'TEMPORARY_STATUS'])(
    'kind %s -> NOT_A_TABLE_MODIFIER',
    (kind) => {
      const conocido = withoutKeys(effect({ kind }), 'statistic', 'operation')

      expect(assessEquipmentEffect(conocido).outcome).toBe(EquipmentEffectOutcome.NotATableModifier)
    },
  )

  it.each([
    ['una estadistica que Combat no conoce', effect({ statistic: 'LUCK' })],
    [
      'una estadistica que podria ser una probabilidad futura',
      effect({ statistic: 'EVADE_CHANCE' }),
    ],
    ['un STAT_MODIFIER sin statistic', withoutKeys(effect({}), 'statistic')],
    ['un kind que Combat no conoce', withoutKeys(effect({ kind: 'FUTURE_KIND' }), 'statistic')],
  ])(
    '%s -> PENDING_DEFINITION (UNRECOGNIZED_EFFECT): no se reinterpreta ni se da por irrelevante',
    (_case, desconocido) => {
      expect(assessEquipmentEffect(desconocido)).toEqual({
        effect: desconocido,
        outcome: EquipmentEffectOutcome.PendingDefinition,
        reasons: [PendingReason.UnrecognizedEffect],
      })
    },
  )

  describe('CRITICAL_CHANCE: cada motivo pendiente se declara, en orden estable', () => {
    it('el efecto soportado (INCREASE PERCENTAGE, SELF, permanente) se aplica y no tiene motivos', () => {
      expect(assessEquipmentEffect(criticalChancePercentageEffect)).toEqual({
        effect: criticalChancePercentageEffect,
        outcome: EquipmentEffectOutcome.AppliedToTable,
        reasons: [],
        modifier: ProbabilityModifier.ofBasisPoints(RandomEffectType.CriticalDamage, 300),
      })
    })

    it('con condicion de activacion: NO se trata como permanente', () => {
      expect(assessEquipmentEffect(effect({ hasActivationCondition: true })).reasons).toEqual([
        PendingReason.ActivationConditionUnevaluated,
      ])
    })

    it('temporal', () => {
      expect(assessEquipmentEffect(effect({ durationTurns: 3 })).reasons).toEqual([
        PendingReason.TemporaryEffectUndefined,
      ])
    })

    it('dirigido a otro objetivo', () => {
      expect(assessEquipmentEffect(effect({ target: 'OPPONENT' })).reasons).toEqual([
        PendingReason.NonSelfTargetUndefined,
      ])
    })

    it.each(['DECREASE', 'MULTIPLY', 'SET', 'BLOCK', 'RESTORE'])(
      'operacion %s: HU-25 solo define incrementos',
      (operation) => {
        expect(assessEquipmentEffect(effect({ operation })).reasons).toEqual([
          PendingReason.OperationUndefined,
        ])
      },
    )

    it('sin operation: tampoco es un incremento definido', () => {
      expect(assessEquipmentEffect(withoutKeys(effect({}), 'operation')).reasons).toEqual([
        PendingReason.OperationUndefined,
      ])
    })

    it.each([
      ['FIXED', { mode: 'FIXED', amount: 3 } as const],
      ['DICE', { mode: 'DICE', count: 1, sides: 6 } as const],
    ])('magnitud %s: la unidad de probabilidad no esta definida', (_mode, magnitude) => {
      expect(assessEquipmentEffect(effect({ magnitude })).reasons).toEqual([
        PendingReason.CriticalChanceUnitUndefined,
      ])
    })

    it('sin magnitud: unidad indefinida', () => {
      expect(assessEquipmentEffect(withoutKeys(effect({}), 'magnitude')).reasons).toEqual([
        PendingReason.CriticalChanceUnitUndefined,
      ])
    })

    it('appliedToStats=true: contradiccion del contrato, ni consolidado ni aplicado', () => {
      expect(assessEquipmentEffect(effect({ appliedToStats: true }))).toEqual({
        effect: effect({ appliedToStats: true }),
        outcome: EquipmentEffectOutcome.PendingDefinition,
        reasons: [PendingReason.CriticalChanceAlreadyInStatsInconsistent],
      })
    })

    it('todos a la vez', () => {
      const todo = effect({
        magnitude: { mode: 'FIXED', amount: 3 },
        appliedToStats: true,
        hasActivationCondition: true,
        durationTurns: 2,
        target: 'ENEMY_GROUP',
        operation: 'DECREASE',
      })

      expect(assessEquipmentEffect(todo).reasons).toEqual([
        PendingReason.CriticalChanceUnitUndefined,
        PendingReason.CriticalChanceAlreadyInStatsInconsistent,
        PendingReason.ActivationConditionUnevaluated,
        PendingReason.TemporaryEffectUndefined,
        PendingReason.NonSelfTargetUndefined,
        PendingReason.OperationUndefined,
      ])
    })
  })
})

describe('buildHeroEffectTable — efectos del contrato completo (HU-25)', () => {
  it('con los cuatro efectos del contrato: uno consolidado, uno aplicado a la tabla y dos ajenos a ella', () => {
    const {
      assessments,
      appliedEffects,
      reflectedInStatsEffects,
      nonTableEffects,
      pendingEffects,
    } = buildHeroEffectTable(equippedHeroFixture())

    expect(assessments.map((a) => a.outcome)).toEqual([
      EquipmentEffectOutcome.ReflectedInStats,
      EquipmentEffectOutcome.AppliedToTable,
      EquipmentEffectOutcome.NotATableModifier,
      EquipmentEffectOutcome.NotATableModifier,
    ])
    expect(appliedEffects.map((a) => a.effect.statistic)).toEqual(['CRITICAL_CHANCE'])
    expect(reflectedInStatsEffects.map((a) => a.effect.statistic)).toEqual(['ATTACK'])
    expect(nonTableEffects).toHaveLength(2)
    expect(pendingEffects).toEqual([])
  })

  it('con los cuatro efectos del contrato la tabla es la del critico +300 pb', () => {
    const { table } = buildHeroEffectTable(equippedHeroFixture())

    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(640)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(2160)
  })

  it('una entrada por efecto recibido y en el mismo orden: ninguno se pierde', () => {
    const efectos = [
      opponentDamageDiceEffect,
      criticalChancePercentageEffect,
      attackBonusEffect,
      conditionalDefenseEffect,
    ]
    const { assessments } = buildHeroEffectTable(equippedHeroFixture({ activeEffects: efectos }))

    expect(assessments.map((a) => a.effect)).toEqual(efectos)
  })

  it('un heroe sin efectos: sin evaluaciones ni pendientes', () => {
    const { assessments, pendingEffects, appliedEffects } = buildHeroEffectTable(
      equippedHeroFixture({ activeEffects: [] }),
    )

    expect(assessments).toEqual([])
    expect(pendingEffects).toEqual([])
    expect(appliedEffects).toEqual([])
  })

  it('no muta el heroe recibido', () => {
    const hero = deepFreeze(equippedHeroFixture())

    expect(() => buildHeroEffectTable(hero)).not.toThrow()
  })
})

describe('BuildHeroEffectTable — playerId -> heroe real -> tabla (HU-25)', () => {
  const portReturning = (
    hero: EquippedHero | null,
  ): PlayerInventoryEquippedHeroPort & {
    readonly calls: string[]
  } => {
    const calls: string[] = []

    return {
      calls,
      getEquippedHero: (playerId) => {
        calls.push(playerId)
        return Promise.resolve(hero)
      },
    }
  }

  it('pide el heroe de ESE jugador una sola vez y construye su tabla', async () => {
    const port = portReturning(equippedHeroFixture({ subtype: 'MAGO_HIELO', activeEffects: [] }))

    const result = await new BuildHeroEffectTable(port).execute('jugador-7')

    expect(port.calls).toEqual(['jugador-7'])
    expect(result.subtype).toBe(HeroSubtype.MagoHielo)
    expect(result.table.ranges).toEqual(baseEffectTableFor(HeroSubtype.MagoHielo).ranges)
  })

  it('jugador sin heroe equipado (null) -> PlayerWithoutEquippedHeroError, no un heroe por defecto', async () => {
    await expect(
      new BuildHeroEffectTable(portReturning(null)).execute('jugador-7'),
    ).rejects.toBeInstanceOf(PlayerWithoutEquippedHeroError)
  })

  it('un fallo de Player-Inventory se propaga tal cual: no se sustituye por una tabla base', async () => {
    const port: PlayerInventoryEquippedHeroPort = {
      getEquippedHero: () =>
        Promise.reject(new UpstreamServiceError('player-inventory', 'no_alcanzable')),
    }

    await expect(new BuildHeroEffectTable(port).execute('jugador-7')).rejects.toBeInstanceOf(
      UpstreamServiceError,
    )
  })

  it('un heroe Chaman obtiene su tabla de sanador (100 % «no causar dano»)', async () => {
    const port = portReturning(equippedHeroFixture({ subtype: 'CHAMAN', activeEffects: [] }))

    const { subtype, table } = await new BuildHeroEffectTable(port).execute('jugador-7')

    expect(subtype).toBe(HeroSubtype.Chaman)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(8000)
  })
})

describe('Cadena contractual completa: JSON de Player-Inventory -> tabla -> efecto (HU-25)', () => {
  const NOW = new Date('2026-09-19T10:00:00.000Z')
  const clock: ClockPort = { now: () => NOW }
  const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }

  const chainFor = (body: unknown): BuildHeroEffectTable =>
    new BuildHeroEffectTable(
      new PlayerInventoryHttpClient({
        baseUrl: 'https://player-inventory.internal',
        callerService: 'combat',
        secret: 'secreto-compartido-de-pruebas',
        clock,
        logger: silentLogger,
        fetchImpl: () =>
          Promise.resolve({
            status: 200,
            ok: true,
            json: () => Promise.resolve(body),
          } as unknown as Response),
      }),
    )

  const resolveAt = (table: EffectControlTable, row: number): RandomEffectType =>
    new ResolveRandomEffect().execute({
      sequence: { nextIndex: () => RandomIndex.create(row) },
      table,
    }).effect

  it('el contrato real (GUERRERO_ARMAS con espada critica +300 pb) resuelve por la tabla MODIFICADA', async () => {
    const { table, pendingEffects, appliedEffects } = await chainFor(
      equippedHeroContractBody(),
    ).execute('jugador-1')

    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(640)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(2160)
    expect(resolveAt(table, 1)).toBe(RandomEffectType.Damage)
    expect(resolveAt(table, 4800)).toBe(RandomEffectType.Damage)
    expect(resolveAt(table, 4801)).toBe(RandomEffectType.CriticalDamage)
    // Con la base el critico terminaba en 5200 y 5201 era EVADE; con +3 puntos
    // absolutos llega a 5440.
    expect(resolveAt(table, 5201)).toBe(RandomEffectType.CriticalDamage)
    expect(resolveAt(table, 5440)).toBe(RandomEffectType.CriticalDamage)
    expect(resolveAt(table, 5441)).toBe(RandomEffectType.Evade)
    expect(resolveAt(table, 5841)).toBe(RandomEffectType.NoDamage)
    expect(resolveAt(table, 8000)).toBe(RandomEffectType.NoDamage)
    expect(pendingEffects).toEqual([])
    expect(appliedEffects).toHaveLength(1)
  })

  it('el mismo indice (5300) da EVADE con la tabla base y CRITICAL_DAMAGE con el equipamiento', async () => {
    const { table } = await chainFor(equippedHeroContractBody()).execute('jugador-1')
    const sinEquipo = await chainFor(equippedHeroContractBody({ activeEffects: [] })).execute(
      'jugador-1',
    )

    expect(resolveAt(sinEquipo.table, 5300)).toBe(RandomEffectType.Evade)
    expect(resolveAt(table, 5300)).toBe(RandomEffectType.CriticalDamage)
  })

  it('el subtipo del JSON decide la tabla: el mismo cuerpo con GUERRERO_TANQUE resuelve distinto', async () => {
    const { table } = await chainFor(
      equippedHeroContractBody({ subtype: 'GUERRERO_TANQUE', activeEffects: [] }),
    ).execute('jugador-1')

    expect(resolveAt(table, 3201)).toBe(RandomEffectType.Evade)
    expect(resolveAt(table, 3601)).toBe(RandomEffectType.Escape)
    expect(resolveAt(table, 4001)).toBe(RandomEffectType.NoDamage)
  })

  it('un JSON de Chaman produce la tabla de sanador: ningun indice causa dano', async () => {
    const { table } = await chainFor(
      equippedHeroContractBody({ subtype: 'CHAMAN', activeEffects: [] }),
    ).execute('jugador-1')

    expect(table.resolve(RandomIndex.create(1)).effect).toBe(RandomEffectType.NoDamage)
    expect(table.resolve(RandomIndex.create(8000)).effect).toBe(RandomEffectType.NoDamage)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(8000)
  })

  it('un Player-Inventory anterior al contrato (sin activeEffects) falla: no se ejecuta la tabla base ignorando el equipamiento', async () => {
    const anterior = equippedHeroContractBody({ activeEffects: undefined })

    await expect(chainFor(anterior).execute('jugador-1')).rejects.toBeInstanceOf(
      UpstreamServiceError,
    )
  })
})
