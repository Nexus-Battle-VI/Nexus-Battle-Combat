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
import { UnsupportedHeroEffectProfileError } from '../../src/domain/errors/RandomEffectErrors'
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
 * vigente. `playerId -> heroe -> subtype -> tabla base`, y que se hace con cada
 * efecto de equipamiento.
 *
 * LO QUE ESTAS PRUEBAS FIJAN, y lo que NO:
 *  - La tabla se elige por el subtipo REAL del heroe (Tablas 21/22).
 *  - Los efectos de equipamiento se RECIBEN y se CLASIFICAN, pero ninguno se
 *    traduce a un `ProbabilityModifier`: el requisito no define como. En
 *    especial `CRITICAL_CHANCE PERCENTAGE 300 pb` (+3 puntos absolutos o +3 %
 *    relativo) NO se resuelve aqui. Las pruebas demuestran que Combat no elige
 *    ninguna de las dos lecturas.
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
    '%s -> UnsupportedHeroEffectProfileError: no se inventa una tabla de sanadores',
    (subtype) => {
      expect(() => buildHeroEffectTable(equippedHeroFixture({ subtype }))).toThrow(
        UnsupportedHeroEffectProfileError,
      )
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

describe('buildHeroEffectTable — CRITICAL_CHANCE PERCENTAGE: la semantica NO se inventa (HU-25)', () => {
  const base = baseEffectTableFor(HeroSubtype.GuerreroArmas)

  it('con la espada de dos manos (CRITICAL_CHANCE PERCENTAGE 300 pb) la tabla vigente ES la base', () => {
    const { table } = buildHeroEffectTable(
      equippedHeroFixture({ activeEffects: [criticalChancePercentageEffect] }),
    )

    expect(table.ranges).toEqual(base.ranges)
    expect(rowsOfTable(table)).toEqual(rowsOfTable(base))
  })

  it('NO elige la lectura ABSOLUTA (+3 puntos = +240 filas: critico 640, sin dano 2160)', () => {
    const { table } = buildHeroEffectTable(
      equippedHeroFixture({ activeEffects: [criticalChancePercentageEffect] }),
    )
    const lecturaAbsoluta = base.withModifiers([
      ProbabilityModifier.ofBasisPoints(RandomEffectType.CriticalDamage, 300),
    ])

    // Control: la lectura absoluta SI produce otra tabla (+240 filas), asi que
    // esta comparacion detectaria que Combat la hubiera adoptado.
    expect(lecturaAbsoluta.rowsOf(RandomEffectType.CriticalDamage)).toBe(640)
    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(400)
    expect(table.rowsOf(RandomEffectType.NoDamage)).toBe(2400)
    expect(table.ranges).not.toEqual(lecturaAbsoluta.ranges)
  })

  it('NO elige la lectura RELATIVA (+3 % sobre el 5 % base = 412 filas)', () => {
    const { table } = buildHeroEffectTable(
      equippedHeroFixture({ activeEffects: [criticalChancePercentageEffect] }),
    )

    // 5 % = 400 filas; +3 % relativo = 400 x 1,03 = 412 filas.
    expect(table.rowsOf(RandomEffectType.CriticalDamage)).not.toBe(412)
    expect(table.rowsOf(RandomEffectType.CriticalDamage)).toBe(400)
  })

  it.each([
    ['100 pb', 100],
    ['300 pb', 300],
    ['600 pb (el +6 % de la Tabla 23)', 600],
    ['10000 pb', 10_000],
  ])('%s de CRITICAL_CHANCE tampoco modifica la tabla', (_label, basisPoints) => {
    const { table, pendingEffects } = buildHeroEffectTable(
      equippedHeroFixture({
        activeEffects: [effect({ magnitude: { mode: 'PERCENTAGE', basisPoints } })],
      }),
    )

    expect(table.ranges).toEqual(base.ranges)
    expect(pendingEffects).toHaveLength(1)
  })

  it.each([
    ['FIXED', { mode: 'FIXED', amount: 3 } as const],
    ['DICE', { mode: 'DICE', count: 1, sides: 6 } as const],
  ])('CRITICAL_CHANCE con magnitud %s: mismo pendiente, la tabla no cambia', (_mode, magnitude) => {
    const { table, pendingEffects } = buildHeroEffectTable(
      equippedHeroFixture({ activeEffects: [effect({ magnitude })] }),
    )

    expect(table.ranges).toEqual(base.ranges)
    expect(pendingEffects[0]?.reasons).toContain(PendingReason.CriticalChanceUnitUndefined)
  })

  it('el efecto queda DECLARADO como pendiente, con su motivo: no se finge que se aplico', () => {
    const { pendingEffects, assessments } = buildHeroEffectTable(
      equippedHeroFixture({ activeEffects: [criticalChancePercentageEffect] }),
    )

    expect(assessments).toHaveLength(1)
    expect(pendingEffects).toEqual([
      {
        effect: criticalChancePercentageEffect,
        outcome: EquipmentEffectOutcome.PendingDefinition,
        reasons: [PendingReason.CriticalChanceUnitUndefined],
      },
    ])
  })

  it('varias piezas con critico (se apilan?): NO se suman ni se escoge una; TODAS quedan pendientes', () => {
    const anillo = effect({
      sourceProductId: 'p-anillo',
      sourceProductReference: 'anillo',
      magnitude: { mode: 'PERCENTAGE', basisPoints: 100 },
    })
    const { table, pendingEffects } = buildHeroEffectTable(
      equippedHeroFixture({ activeEffects: [criticalChancePercentageEffect, anillo] }),
    )

    expect(table.ranges).toEqual(base.ranges)
    expect(pendingEffects.map((p) => p.effect.sourceProductReference)).toEqual([
      'espada-de-dos-manos',
      'anillo',
    ])
  })

  it('un CRITICAL_CHANCE marcado appliedToStats=true NO se da por consolidado (effectiveStats no tiene critico)', () => {
    const contradictorio = effect({ appliedToStats: true })
    const { pendingEffects } = buildHeroEffectTable(
      equippedHeroFixture({ activeEffects: [contradictorio] }),
    )

    expect(pendingEffects).toHaveLength(1)
    expect(pendingEffects[0]?.outcome).toBe(EquipmentEffectOutcome.PendingDefinition)
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

  describe('CRITICAL_CHANCE: cada motivo adicional se declara, en orden estable', () => {
    it('con condicion de activacion: NO se trata como permanente', () => {
      expect(assessEquipmentEffect(effect({ hasActivationCondition: true })).reasons).toEqual([
        PendingReason.CriticalChanceUnitUndefined,
        PendingReason.ActivationConditionUnevaluated,
      ])
    })

    it('temporal', () => {
      expect(assessEquipmentEffect(effect({ durationTurns: 3 })).reasons).toEqual([
        PendingReason.CriticalChanceUnitUndefined,
        PendingReason.TemporaryEffectUndefined,
      ])
    })

    it('dirigido a otro objetivo', () => {
      expect(assessEquipmentEffect(effect({ target: 'OPPONENT' })).reasons).toEqual([
        PendingReason.CriticalChanceUnitUndefined,
        PendingReason.NonSelfTargetUndefined,
      ])
    })

    it.each(['DECREASE', 'MULTIPLY', 'SET', 'BLOCK', 'RESTORE'])(
      'operacion %s: HU-25 solo define incrementos',
      (operation) => {
        expect(assessEquipmentEffect(effect({ operation })).reasons).toEqual([
          PendingReason.CriticalChanceUnitUndefined,
          PendingReason.OperationUndefined,
        ])
      },
    )

    it('sin operation: tampoco es un incremento definido', () => {
      expect(assessEquipmentEffect(withoutKeys(effect({}), 'operation')).reasons).toContain(
        PendingReason.OperationUndefined,
      )
    })

    it('todos a la vez', () => {
      const todo = effect({
        hasActivationCondition: true,
        durationTurns: 2,
        target: 'ENEMY_GROUP',
        operation: 'DECREASE',
      })

      expect(assessEquipmentEffect(todo).reasons).toEqual([
        PendingReason.CriticalChanceUnitUndefined,
        PendingReason.ActivationConditionUnevaluated,
        PendingReason.TemporaryEffectUndefined,
        PendingReason.NonSelfTargetUndefined,
        PendingReason.OperationUndefined,
      ])
    })
  })
})

describe('buildHeroEffectTable — efectos del contrato completo (HU-25)', () => {
  it('con los cuatro efectos del contrato: uno consolidado, uno pendiente y dos ajenos a la tabla', () => {
    const { assessments, pendingEffects, table } = buildHeroEffectTable(equippedHeroFixture())

    expect(assessments.map((a) => a.outcome)).toEqual([
      EquipmentEffectOutcome.ReflectedInStats,
      EquipmentEffectOutcome.PendingDefinition,
      EquipmentEffectOutcome.NotATableModifier,
      EquipmentEffectOutcome.NotATableModifier,
    ])
    expect(pendingEffects.map((a) => a.effect.statistic)).toEqual(['CRITICAL_CHANCE'])
    expect(table.ranges).toEqual(baseEffectTableFor(HeroSubtype.GuerreroArmas).ranges)
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
    const { assessments, pendingEffects } = buildHeroEffectTable(
      equippedHeroFixture({ activeEffects: [] }),
    )

    expect(assessments).toEqual([])
    expect(pendingEffects).toEqual([])
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

  it('un heroe Chaman falla con UnsupportedHeroEffectProfileError', async () => {
    const port = portReturning(equippedHeroFixture({ subtype: 'CHAMAN' }))

    await expect(new BuildHeroEffectTable(port).execute('jugador-7')).rejects.toBeInstanceOf(
      UnsupportedHeroEffectProfileError,
    )
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

  it('el contrato real (GUERRERO_ARMAS con espada critica) resuelve por la Tabla 22, sin aplicar el critico pendiente', async () => {
    const { table, pendingEffects } = await chainFor(equippedHeroContractBody()).execute(
      'jugador-1',
    )

    expect(resolveAt(table, 1)).toBe(RandomEffectType.Damage)
    expect(resolveAt(table, 4800)).toBe(RandomEffectType.Damage)
    expect(resolveAt(table, 4801)).toBe(RandomEffectType.CriticalDamage)
    expect(resolveAt(table, 5200)).toBe(RandomEffectType.CriticalDamage)
    // Con +3 puntos absolutos el critico llegaria a la fila 5440 y esto seria
    // CRITICAL_DAMAGE: que sea EVADE prueba que la lectura absoluta NO se aplico.
    expect(resolveAt(table, 5201)).toBe(RandomEffectType.Evade)
    expect(resolveAt(table, 5601)).toBe(RandomEffectType.NoDamage)
    expect(resolveAt(table, 8000)).toBe(RandomEffectType.NoDamage)
    expect(pendingEffects).toHaveLength(1)
  })

  it('el subtipo del JSON decide la tabla: el mismo cuerpo con GUERRERO_TANQUE resuelve distinto', async () => {
    const { table } = await chainFor(
      equippedHeroContractBody({ subtype: 'GUERRERO_TANQUE', activeEffects: [] }),
    ).execute('jugador-1')

    expect(resolveAt(table, 3201)).toBe(RandomEffectType.Evade)
    expect(resolveAt(table, 3601)).toBe(RandomEffectType.Escape)
    expect(resolveAt(table, 4001)).toBe(RandomEffectType.NoDamage)
  })

  it('un JSON de Chaman falla de forma explicita, sin una tabla inventada', async () => {
    await expect(
      chainFor(equippedHeroContractBody({ subtype: 'CHAMAN' })).execute('jugador-1'),
    ).rejects.toBeInstanceOf(UnsupportedHeroEffectProfileError)
  })

  it('un Player-Inventory anterior al contrato (sin activeEffects) falla: no se ejecuta la tabla base ignorando el equipamiento', async () => {
    const anterior = equippedHeroContractBody({ activeEffects: undefined })

    await expect(chainFor(anterior).execute('jugador-1')).rejects.toBeInstanceOf(
      UpstreamServiceError,
    )
  })
})
