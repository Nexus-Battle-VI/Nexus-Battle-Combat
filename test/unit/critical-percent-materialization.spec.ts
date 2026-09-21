import { baseEffectTableFor } from '../../src/domain/random-effects/BaseEffectProfiles'
import { EFFECT_TABLE_ROWS } from '../../src/domain/random-effects/EffectControlTable'
import {
  EFFECT_MAGNITUDES,
  materializePercent,
} from '../../src/domain/random-effects/EffectMagnitude'
import { ProbabilityModifier } from '../../src/domain/random-effects/ProbabilityModifier'
import {
  RANDOM_EFFECT_ORDER,
  RandomEffectType,
} from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'

const C = RandomEffectType.CriticalDamage

const CRITICAL_RANGE = EFFECT_MAGNITUDES[C]

/**
 * HU-25, pendiente «critico 120-180»: el documento solo define el intervalo, asi
 * que el porcentaje concreto se materializa por la POSICION de la fila dentro
 * del rango del critico. Decision de diseno adoptada por instruccion del
 * PO/profesor de resolver los pendientes con el documento: una funcion pura del
 * MISMO indice, sin un segundo indice ni otra fuente de aleatoriedad.
 */
describe('materializePercent (critico 120-180)', () => {
  it('el critico oficial es el intervalo 120..180', () => {
    expect(CRITICAL_RANGE).toEqual({ kind: 'PERCENT_RANGE', minPercent: 120, maxPercent: 180 })
  })

  it.each([
    [0, 400, 120],
    [399, 400, 180],
    [200, 400, 150],
    [1, 400, 120],
    [0, 880, 120],
    [879, 880, 180],
  ])('la fila %i de %i filas del critico da %i %%', (offset, rows, expected) => {
    expect(materializePercent(CRITICAL_RANGE, offset, rows)).toBe(expected)
  })

  it('un solo fila (rango de tamano 1) da el minimo del intervalo', () => {
    expect(materializePercent(CRITICAL_RANGE, 0, 1)).toBe(120)
  })

  it('un efecto de magnitud fija devuelve su porcentaje sin mirar la posicion', () => {
    expect(materializePercent({ kind: 'FIXED_PERCENT', percent: 80 }, 0, 240)).toBe(80)
    expect(materializePercent({ kind: 'FIXED_PERCENT', percent: 80 }, 239, 240)).toBe(80)
  })

  it('es entera y nunca sale del intervalo, para cualquier tamano de rango razonable', () => {
    for (const rows of [1, 2, 60, 61, 62, 100, 400, 880, 1600, 8000]) {
      for (let offset = 0; offset < rows; offset += 1) {
        const percent = materializePercent(CRITICAL_RANGE, offset, rows)

        expect(Number.isInteger(percent)).toBe(true)
        expect(percent).toBeGreaterThanOrEqual(120)
        expect(percent).toBeLessThanOrEqual(180)
      }
    }
  })
})

describe('EffectControlTable.resolve: el porcentaje que se aplica', () => {
  const armas = baseEffectTableFor(HeroSubtype.GuerreroArmas)
  const armasEquipado = armas.withModifiers([ProbabilityModifier.ofBasisPoints(C, 600)])
  const at = (table: typeof armas, row: number): ReturnType<typeof armas.resolve> =>
    table.resolve(RandomIndex.create(row))

  describe('efectos de porcentaje fijo (Tabla 22)', () => {
    it.each([
      [1, RandomEffectType.Damage, 100],
      [4800, RandomEffectType.Damage, 100],
      [5201, RandomEffectType.Evade, 80],
      [5440, RandomEffectType.Evade, 80],
      [5441, RandomEffectType.Escape, 20],
      [5600, RandomEffectType.Escape, 20],
      [5601, RandomEffectType.NoDamage, 0],
      [8000, RandomEffectType.NoDamage, 0],
    ])('la fila %i es %s y causa el %i %%', (row, effect, percent) => {
      expect(at(armas, row)).toMatchObject({ effect, percent })
    })

    it('«resisten el golpe» causa el 60 % (Mago Fuego, fila 6001)', () => {
      const fuego = baseEffectTableFor(HeroSubtype.MagoFuego)

      expect(at(fuego, 6001)).toMatchObject({ effect: RandomEffectType.Resist, percent: 60 })
    })
  })

  describe('critico de la Tabla 22 (400 filas: 4801-5200)', () => {
    it('la primera fila del critico da 120 % y la ultima 180 %', () => {
      expect(at(armas, 4801)).toMatchObject({ effect: C, percent: 120 })
      expect(at(armas, 5200)).toMatchObject({ effect: C, percent: 180 })
    })

    it('conserva la magnitud oficial (el intervalo) y ademas trae el porcentaje concreto', () => {
      expect(at(armas, 5000)).toEqual({
        effect: C,
        magnitude: { kind: 'PERCENT_RANGE', minPercent: 120, maxPercent: 180 },
        percent: 150,
      })
    })

    it('crece con la fila: no baja nunca al avanzar dentro del critico', () => {
      let previous = 0

      for (let row = 4801; row <= 5200; row += 1) {
        const { percent } = at(armas, row)

        expect(percent).toBeGreaterThanOrEqual(previous)
        previous = percent
      }
    })

    it('los 61 porcentajes enteros 120..180 son alcanzables y reciben casi las mismas filas', () => {
      const rowsPerPercent = new Map<number, number>()

      for (let row = 4801; row <= 5200; row += 1) {
        const { percent } = at(armas, row)

        rowsPerPercent.set(percent, (rowsPerPercent.get(percent) ?? 0) + 1)
      }

      expect([...rowsPerPercent.keys()].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 61 }, (_, position) => 120 + position),
      )

      const counts = [...rowsPerPercent.values()]

      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(400)
      // 400 / 61 = 6,56: cada porcentaje recibe 6 o 7 filas (no hay preferencia).
      expect(Math.min(...counts)).toBe(6)
      expect(Math.max(...counts)).toBe(7)
    })
  })

  describe('critico de la Tabla 23 (880 filas: 4801-5680)', () => {
    it('el intervalo se reparte sobre las 880 filas: 120 % al inicio, 180 % al final', () => {
      expect(at(armasEquipado, 4801)).toMatchObject({ effect: C, percent: 120 })
      expect(at(armasEquipado, 5680)).toMatchObject({ effect: C, percent: 180 })
    })

    it('el mismo indice puede dar otro porcentaje si el equipo cambia el tamano del rango', () => {
      // Fila 5000: 200 filas dentro del critico en ambas tablas, pero de 400 contra 880.
      expect(at(armas, 5000).percent).toBe(150)
      expect(at(armasEquipado, 5000).percent).toBe(120 + Math.floor((199 * 61) / 880))
    })

    it('recorriendo las 8000 filas, todo efecto trae un porcentaje entero coherente con su magnitud', () => {
      for (let row = 1; row <= EFFECT_TABLE_ROWS; row += 1) {
        const resolved = at(armasEquipado, row)
        const { magnitude } = resolved

        expect(Number.isInteger(resolved.percent)).toBe(true)

        if (magnitude.kind === 'FIXED_PERCENT') {
          expect(resolved.percent).toBe(magnitude.percent)
        } else {
          expect(resolved.percent).toBeGreaterThanOrEqual(magnitude.minPercent)
          expect(resolved.percent).toBeLessThanOrEqual(magnitude.maxPercent)
        }
      }
    })
  })

  describe('no introduce aleatoriedad', () => {
    it('es funcion pura del indice: mismo indice y misma tabla, mismo resultado', () => {
      for (const row of [1, 4801, 5000, 5200, 5601, 8000]) {
        expect(at(armas, row)).toEqual(at(armas, row))
      }
    })

    it('no llama a Math.random', () => {
      const spy = jest.spyOn(Math, 'random')

      for (const table of [armas, armasEquipado]) {
        for (let row = 1; row <= EFFECT_TABLE_ROWS; row += 200) {
          at(table, row)
        }
      }

      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  it('cada tabla base (los 8 subtipos) resuelve las 8000 filas con un porcentaje del documento', () => {
    const allowed = new Set([0, 20, 60, 80, 100])

    for (const subtype of Object.values(HeroSubtype)) {
      const table = baseEffectTableFor(subtype)

      for (const effect of RANDOM_EFFECT_ORDER) {
        expect(table.rowsOf(effect)).toBeGreaterThanOrEqual(0)
      }

      for (let row = 1; row <= EFFECT_TABLE_ROWS; row += 1) {
        const { magnitude, percent } = at(table, row)

        expect(magnitude.kind === 'PERCENT_RANGE' ? percent >= 120 : allowed.has(percent)).toBe(
          true,
        )
      }
    }
  })
})
