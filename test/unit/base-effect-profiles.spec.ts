import {
  BASE_EFFECT_PERCENTAGES,
  ROWS_PER_PERCENT,
  baseEffectTableFor,
} from '../../src/domain/random-effects/BaseEffectProfiles'
import {
  EFFECT_TABLE_ROWS,
  type EffectControlTable,
} from '../../src/domain/random-effects/EffectControlTable'
import {
  RANDOM_EFFECT_ORDER,
  RandomEffectType,
} from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'

type Expected = readonly (readonly [RandomEffectType, number, number])[]

const at = (table: EffectControlTable, row: number): RandomEffectType =>
  table.resolve(RandomIndex.create(row)).effect

const D = RandomEffectType.Damage
const C = RandomEffectType.CriticalDamage
const E = RandomEffectType.Evade
const R = RandomEffectType.Resist
const S = RandomEffectType.Escape
const N = RandomEffectType.NoDamage

/**
 * Rangos derivados matematicamente de la Tabla 21 (1 punto porcentual = 80
 * filas) y del orden fijo confirmado. Transcripcion LITERAL e independiente de
 * `BASE_EFFECT_PERCENTAGES`: si alguien altera un porcentaje, este listado no
 * cambia y la prueba falla.
 */
const EXPECTED_RANGES: readonly (readonly [HeroSubtype, Expected])[] = [
  [
    HeroSubtype.GuerreroTanque,
    [
      [D, 1, 3200],
      [E, 3201, 3600],
      [S, 3601, 4000],
      [N, 4001, 8000],
    ],
  ],
  [
    HeroSubtype.GuerreroArmas,
    [
      [D, 1, 4800],
      [C, 4801, 5200],
      [E, 5201, 5440],
      [S, 5441, 5600],
      [N, 5601, 8000],
    ],
  ],
  [
    HeroSubtype.MagoFuego,
    [
      [D, 1, 5600],
      [C, 5601, 6000],
      [R, 6001, 6400],
      [N, 6401, 8000],
    ],
  ],
  [
    HeroSubtype.MagoHielo,
    [
      [D, 1, 5600],
      [C, 5601, 6080],
      [R, 6081, 6400],
      [N, 6401, 8000],
    ],
  ],
  [
    HeroSubtype.PicaroVeneno,
    [
      [D, 1, 4400],
      [C, 4401, 5200],
      [N, 5201, 8000],
    ],
  ],
  [
    HeroSubtype.PicaroMachete,
    [
      [D, 1, 4800],
      [C, 4801, 5440],
      [S, 5441, 5600],
      [N, 5601, 8000],
    ],
  ],
]

/**
 * Tabla 21, transcripcion LITERAL de los seis heroes que atacan:
 * [Causar, Critico, Evaden, Resisten, Escapan, No causar]. Los sanadores tienen
 * su propio bloque mas abajo: el documento imprime 0 % en todas sus filas.
 */
const TABLE_21: readonly (readonly [HeroSubtype, readonly number[]])[] = [
  [HeroSubtype.GuerreroTanque, [40, 0, 5, 0, 5, 50]],
  [HeroSubtype.GuerreroArmas, [60, 5, 3, 0, 2, 30]],
  [HeroSubtype.MagoFuego, [70, 5, 0, 5, 0, 20]],
  [HeroSubtype.MagoHielo, [70, 6, 0, 4, 0, 20]],
  [HeroSubtype.PicaroVeneno, [55, 10, 0, 0, 0, 35]],
  [HeroSubtype.PicaroMachete, [60, 8, 0, 0, 2, 30]],
]

describe('Configuraciones base (Tabla 21)', () => {
  it('8000 filas = 100 %, luego 1 punto porcentual = 80 filas', () => {
    expect(ROWS_PER_PERCENT).toBe(80)
  })

  it.each(TABLE_21)('los porcentajes de %s coinciden con la Tabla 21', (subtype, percentages) => {
    const configured = BASE_EFFECT_PERCENTAGES[subtype]

    expect(RANDOM_EFFECT_ORDER.map((effect) => configured[effect])).toEqual(percentages)
  })

  describe.each(EXPECTED_RANGES)('%s', (subtype, expected) => {
    const table = baseEffectTableFor(subtype)

    it('los rangos coinciden con los derivados de la Tabla 21', () => {
      expect(table.ranges.map((range) => [range.effect, range.firstRow, range.lastRow])).toEqual(
        expected,
      )
    })

    it('las filas de cada efecto son su porcentaje x 80 y suman exactamente 8000', () => {
      const percentages = BASE_EFFECT_PERCENTAGES[subtype]
      let total = 0

      for (const effect of RANDOM_EFFECT_ORDER) {
        expect(table.rowsOf(effect)).toBe(percentages[effect] * 80)
        total += table.rowsOf(effect)
      }

      expect(total).toBe(EFFECT_TABLE_ROWS)
    })

    it('cubre 1..8000 sin huecos ni solapamientos y cada indice resuelve un solo efecto', () => {
      const perEffect = new Map<RandomEffectType, number>()

      for (let row = 1; row <= EFFECT_TABLE_ROWS; row += 1) {
        const effect = at(table, row)
        perEffect.set(effect, (perEffect.get(effect) ?? 0) + 1)
      }

      for (const effect of RANDOM_EFFECT_ORDER) {
        expect(perEffect.get(effect) ?? 0).toBe(table.rowsOf(effect))
      }
    })

    it('el 0 % no crea rango y las fronteras de cada rango resuelven su efecto', () => {
      const withRows = new Set(expected.map(([effect]) => effect))

      for (const effect of RANDOM_EFFECT_ORDER) {
        expect(table.ranges.some((range) => range.effect === effect)).toBe(withRows.has(effect))
      }

      for (const [effect, first, last] of expected) {
        expect(at(table, first)).toBe(effect)
        expect(at(table, last)).toBe(effect)
      }

      expect(at(table, 1)).toBe(expected[0]?.[0])
      expect(at(table, 8000)).toBe(N)
    })

    it('el primer indice del rango siguiente pertenece al efecto siguiente', () => {
      expected.forEach(([, , last], position) => {
        const next = expected[position + 1]

        if (next !== undefined) {
          expect(at(table, last + 1)).toBe(next[0])
        }
      })
    })
  })

  /**
   * DECISION DE DISENO (no transcripcion): el documento imprime 0 % en las seis
   * filas de Chaman y Medico (Tabla 21), que no suma 100 %, y su nota del proyecto
   * pide disenar las tablas de todos los personajes sin desequilibrar el juego.
   * Sin Ataque ni Dano (Tabla 6: «-») la unica distribucion que respeta todo lo que
   * el documento dice de ellos es «no causar dano» = 100 %.
   */
  describe('Sanadores (Chaman y Medico): «no causar dano» = 100 % (decision de diseno)', () => {
    const SANADORES = [HeroSubtype.Chaman, HeroSubtype.Medico] as const

    it.each(SANADORES)(
      '%s: 0 % en los cinco efectos que danan y 100 % en «no causar dano»',
      (subtype) => {
        expect(
          RANDOM_EFFECT_ORDER.map((effect) => BASE_EFFECT_PERCENTAGES[subtype][effect]),
        ).toEqual([0, 0, 0, 0, 0, 100])
      },
    )

    it.each(SANADORES)('%s: la tabla existe y sus 8000 filas son «no causar dano»', (subtype) => {
      const table = baseEffectTableFor(subtype)

      expect(table.ranges.map((range) => [range.effect, range.firstRow, range.lastRow])).toEqual([
        [N, 1, EFFECT_TABLE_ROWS],
      ])
      expect(table.rowsOf(N)).toBe(EFFECT_TABLE_ROWS)

      for (const effect of [D, C, E, R, S]) {
        expect(table.rowsOf(effect)).toBe(0)
      }

      expect(at(table, 1)).toBe(N)
      expect(at(table, 4000)).toBe(N)
      expect(at(table, EFFECT_TABLE_ROWS)).toBe(N)
    })

    it.each(SANADORES)(
      '%s no gana ninguna capacidad ofensiva: ningun indice produce dano',
      (subtype) => {
        const table = baseEffectTableFor(subtype)

        for (let row = 1; row <= EFFECT_TABLE_ROWS; row += 1) {
          expect(table.resolve(RandomIndex.create(row)).percent).toBe(0)
        }
      },
    )
  })

  it('todos los subtipos del registro tienen un perfil y cada uno suma exactamente 100 %', () => {
    expect(Object.keys(BASE_EFFECT_PERCENTAGES).sort()).toEqual(Object.values(HeroSubtype).sort())

    for (const subtype of Object.values(HeroSubtype)) {
      const total = RANDOM_EFFECT_ORDER.reduce(
        (sum, effect) => sum + BASE_EFFECT_PERCENTAGES[subtype][effect],
        0,
      )

      expect({ subtype, total }).toEqual({ subtype, total: 100 })
    }
  })

  it('cada llamada devuelve una tabla equivalente e independiente', () => {
    const first = baseEffectTableFor(HeroSubtype.MagoFuego)
    const second = baseEffectTableFor(HeroSubtype.MagoFuego)

    expect(first).not.toBe(second)
    expect(first.ranges).toEqual(second.ranges)
  })
})
