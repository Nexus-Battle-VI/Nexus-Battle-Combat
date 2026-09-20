import { baseEffectTableFor } from '../../src/domain/random-effects/BaseEffectProfiles'
import { EFFECT_MAGNITUDES } from '../../src/domain/random-effects/EffectMagnitude'
import { ProbabilityModifier } from '../../src/domain/random-effects/ProbabilityModifier'
import {
  RANDOM_EFFECT_ORDER,
  RandomEffectType,
} from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'

/**
 * Tablas 22 y 23 del documento oficial "Proyecto Integrador II" (seccion 6.1.4),
 * transcritas LITERALMENTE columna por columna:
 *
 *   [efecto, porcentaje, cantidad de filas, primera fila, ultima fila, efecto esperado]
 *
 * `null` en las filas = "sin rango" (0 filas). Son la especificacion; el
 * codigo se contrasta contra ellas.
 */
type OfficialRow = readonly [
  effect: RandomEffectType,
  percent: number,
  rows: number,
  first: number | null,
  last: number | null,
]

const D = RandomEffectType.Damage
const C = RandomEffectType.CriticalDamage
const E = RandomEffectType.Evade
const R = RandomEffectType.Resist
const S = RandomEffectType.Escape
const N = RandomEffectType.NoDamage

const TABLE_22: readonly OfficialRow[] = [
  [D, 60, 4800, 1, 4800],
  [C, 5, 400, 4801, 5200],
  [E, 3, 240, 5201, 5440],
  [R, 0, 0, null, null],
  [S, 2, 160, 5441, 5600],
  [N, 30, 2400, 5601, 8000],
]

const TABLE_23: readonly OfficialRow[] = [
  [D, 60, 4800, 1, 4800],
  [C, 11, 880, 4801, 5680],
  [E, 3, 240, 5681, 5920],
  [R, 0, 0, null, null],
  [S, 2, 160, 5921, 6080],
  [N, 24, 1920, 6081, 8000],
]

const at = (
  table: ReturnType<typeof baseEffectTableFor>,
  row: number,
): ReturnType<typeof table.resolve> => table.resolve(RandomIndex.create(row))

const assertMatchesOfficialTable = (
  table: ReturnType<typeof baseEffectTableFor>,
  official: readonly OfficialRow[],
): void => {
  for (const [effect, percent, rows, first, last] of official) {
    expect(table.rowsOf(effect)).toBe(rows)
    expect(table.rowsOf(effect)).toBe(percent * 80)

    const range = table.ranges.find((candidate) => candidate.effect === effect)

    if (first === null || last === null) {
      expect(range).toBeUndefined()
    } else {
      expect(range).toEqual({ effect, firstRow: first, lastRow: last })
      expect(last - first + 1).toBe(rows)
    }
  }

  expect(official.reduce((sum, [, percent]) => sum + percent, 0)).toBe(100)
  expect(official.reduce((sum, [, , rows]) => sum + rows, 0)).toBe(8000)
}

describe('Tabla 22 — Guerrero Armas base', () => {
  const table = baseEffectTableFor(HeroSubtype.GuerreroArmas)

  it('reproduce exactamente porcentaje, filas y rango de cada efecto', () => {
    assertMatchesOfficialTable(table, TABLE_22)
  })

  it.each([
    [1, D],
    [4800, D],
    [4801, C],
    [5200, C],
    [5201, E],
    [5440, E],
    [5441, S],
    [5600, S],
    [5601, N],
    [8000, N],
  ])('frontera: la fila %i es %s', (row, effect) => {
    expect(at(table, row)).toEqual({ effect, magnitude: EFFECT_MAGNITUDES[effect] })
  })

  it('"Resisten el golpe" (0 %) no ocupa ninguna fila: ningun indice lo resuelve', () => {
    for (let row = 1; row <= 8000; row += 1) {
      expect(at(table, row).effect).not.toBe(R)
    }
  })

  it('el efecto esperado de cada fila es el del documento (100 / 120-180 / 80 / 20 / 0 %)', () => {
    expect(at(table, 1500).magnitude).toEqual({ kind: 'FIXED_PERCENT', percent: 100 })
    expect(at(table, 5000).magnitude).toEqual({
      kind: 'PERCENT_RANGE',
      minPercent: 120,
      maxPercent: 180,
    })
    expect(at(table, 5300).magnitude).toEqual({ kind: 'FIXED_PERCENT', percent: 80 })
    expect(at(table, 5500).magnitude).toEqual({ kind: 'FIXED_PERCENT', percent: 20 })
    expect(at(table, 7000).magnitude).toEqual({ kind: 'FIXED_PERCENT', percent: 0 })
    expect(EFFECT_MAGNITUDES[R]).toEqual({ kind: 'FIXED_PERCENT', percent: 60 })
  })
})

describe('Tabla 23 — Guerrero Armas con +6 % de critico (equipamiento)', () => {
  const base = baseEffectTableFor(HeroSubtype.GuerreroArmas)
  const equipped = base.withModifiers([ProbabilityModifier.ofBasisPoints(C, 600)])

  it('reproduce exactamente porcentaje, filas y rango de cada efecto', () => {
    assertMatchesOfficialTable(equipped, TABLE_23)
  })

  it('el critico pasa de 5 % a 11 % (400 -> 880 filas) y "no causar dano" de 30 % a 24 % (2400 -> 1920)', () => {
    expect(base.rowsOf(C)).toBe(400)
    expect(equipped.rowsOf(C)).toBe(880)
    expect(base.rowsOf(N)).toBe(2400)
    expect(equipped.rowsOf(N)).toBe(1920)
  })

  it('los demas efectos no cambian de tamano y el total sigue siendo 8000', () => {
    for (const effect of [D, E, R, S]) {
      expect(equipped.rowsOf(effect)).toBe(base.rowsOf(effect))
    }

    expect(RANDOM_EFFECT_ORDER.reduce((sum, effect) => sum + equipped.rowsOf(effect), 0)).toBe(8000)
  })

  it('el equivalente en filas (+480) produce la misma tabla', () => {
    const viaRows = base.withModifiers([ProbabilityModifier.ofRows(C, 480)])

    expect(viaRows.ranges).toEqual(equipped.ranges)
  })

  it.each([
    [1, D],
    [4800, D],
    [4801, C],
    [5680, C],
    [5681, E],
    [5920, E],
    [5921, S],
    [6080, S],
    [6081, N],
    [8000, N],
  ])('frontera: la fila %i es %s', (row, effect) => {
    expect(at(equipped, row).effect).toBe(effect)
  })

  it('el equipamiento mueve los limites: la fila 5300 es critico ahora y era evasion en la base', () => {
    expect(at(base, 5300).effect).toBe(E)
    expect(at(equipped, 5300).effect).toBe(C)
  })

  it('la tabla base no se modifica al derivar la equipada', () => {
    expect(base.rowsOf(C)).toBe(400)
    assertMatchesOfficialTable(base, TABLE_22)
  })
})
