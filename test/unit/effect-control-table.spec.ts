import {
  IncompleteEffectDistributionError,
  InvalidEffectTableError,
} from '../../src/domain/errors/RandomEffectErrors'
import { InvalidRandomIndexError } from '../../src/domain/errors/RandomnessErrors'
import {
  EFFECT_TABLE_ROWS,
  EffectControlTable,
  type EffectRowCounts,
} from '../../src/domain/random-effects/EffectControlTable'
import { EFFECT_MAGNITUDES } from '../../src/domain/random-effects/EffectMagnitude'
import {
  RANDOM_EFFECT_ORDER,
  RandomEffectType,
} from '../../src/domain/random-effects/RandomEffectType'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'

const rows = (
  damage: number,
  criticalDamage: number,
  evade: number,
  resist: number,
  escape: number,
  noDamage: number,
): EffectRowCounts => ({
  [RandomEffectType.Damage]: damage,
  [RandomEffectType.CriticalDamage]: criticalDamage,
  [RandomEffectType.Evade]: evade,
  [RandomEffectType.Resist]: resist,
  [RandomEffectType.Escape]: escape,
  [RandomEffectType.NoDamage]: noDamage,
})

const at = (table: EffectControlTable, row: number): RandomEffectType =>
  table.resolve(RandomIndex.create(row)).effect

/** Ejemplo autoritativo (Tabla 22): 4800 / 400 / 240 / 0 / 160 / 2400. */
const warriorWeapons = (): EffectControlTable =>
  EffectControlTable.fromRowCounts(rows(4800, 400, 240, 0, 160, 2400))

describe('EffectControlTable', () => {
  describe('la tabla tiene 8000 filas, alineadas con RandomIndex', () => {
    it('EFFECT_TABLE_ROWS es 8000 y coincide con el maximo de RandomIndex', () => {
      expect(EFFECT_TABLE_ROWS).toBe(8000)
      expect(EFFECT_TABLE_ROWS).toBe(RandomIndex.MAX)
    })

    it('el orden fijo de efectos es el confirmado por el profesor', () => {
      expect(RANDOM_EFFECT_ORDER).toEqual([
        'DAMAGE',
        'CRITICAL_DAMAGE',
        'EVADE',
        'RESIST',
        'ESCAPE',
        'NO_DAMAGE',
      ])
    })
  })

  describe('invariantes por construccion (recorriendo las 8000 filas)', () => {
    const table = warriorWeapons()

    it('cada fila resuelve exactamente un efecto y el reparto coincide con las filas asignadas', () => {
      const counted = new Map<RandomEffectType, number>()

      for (let row = 1; row <= EFFECT_TABLE_ROWS; row += 1) {
        const effect = at(table, row)
        counted.set(effect, (counted.get(effect) ?? 0) + 1)
      }

      for (const effect of RANDOM_EFFECT_ORDER) {
        expect(counted.get(effect) ?? 0).toBe(table.rowsOf(effect))
      }

      expect([...counted.values()].reduce((sum, value) => sum + value, 0)).toBe(8000)
    })

    it('los rangos son contiguos, sin huecos ni solapamientos, de la fila 1 a la 8000', () => {
      const { ranges } = table

      expect(ranges[0]?.firstRow).toBe(1)
      expect(ranges[ranges.length - 1]?.lastRow).toBe(8000)

      ranges.forEach((range, position) => {
        expect(range.lastRow).toBeGreaterThanOrEqual(range.firstRow)

        const previous = ranges[position - 1]
        if (previous !== undefined) {
          expect(range.firstRow).toBe(previous.lastRow + 1)
        }
      })
    })

    it('los efectos aparecen en el orden fijo (nunca un efecto anterior tras uno posterior)', () => {
      let highestSeen = -1

      for (let row = 1; row <= EFFECT_TABLE_ROWS; row += 1) {
        const position = RANDOM_EFFECT_ORDER.indexOf(at(table, row))

        expect(position).toBeGreaterThanOrEqual(highestSeen)
        highestSeen = position
      }
    })

    it('un efecto con 0 filas no genera ningun rango', () => {
      expect(table.rowsOf(RandomEffectType.Resist)).toBe(0)
      expect(table.ranges.map((range) => range.effect)).not.toContain(RandomEffectType.Resist)
      expect(table.ranges).toHaveLength(5)
    })

    it('los rangos declarados coinciden con lo que resuelve cada fila (rango = 8000 filas)', () => {
      for (const range of table.ranges) {
        expect(at(table, range.firstRow)).toBe(range.effect)
        expect(at(table, range.lastRow)).toBe(range.effect)
      }
    })
  })

  describe('resolve devuelve efecto y magnitud oficiales', () => {
    const table = warriorWeapons()

    it.each([
      [1, RandomEffectType.Damage],
      [1500, RandomEffectType.Damage],
      [4800, RandomEffectType.Damage],
      [4801, RandomEffectType.CriticalDamage],
      [5200, RandomEffectType.CriticalDamage],
      [5201, RandomEffectType.Evade],
      [5300, RandomEffectType.Evade],
      [5440, RandomEffectType.Evade],
      [5441, RandomEffectType.Escape],
      [5500, RandomEffectType.Escape],
      [5600, RandomEffectType.Escape],
      [5601, RandomEffectType.NoDamage],
      [7000, RandomEffectType.NoDamage],
      [8000, RandomEffectType.NoDamage],
    ])('la fila %i resuelve %s', (row, effect) => {
      const resolved = table.resolve(RandomIndex.create(row))

      expect(resolved.effect).toBe(effect)
      expect(resolved.magnitude).toBe(EFFECT_MAGNITUDES[effect])
    })

    it('la magnitud critica es un RANGO 120-180: no se materializa un valor concreto', () => {
      expect(table.resolve(RandomIndex.create(5000)).magnitude).toEqual({
        kind: 'PERCENT_RANGE',
        minPercent: 120,
        maxPercent: 180,
      })
    })

    it('las magnitudes oficiales son 100 / 120-180 / 80 / 60 / 20 / 0', () => {
      expect(EFFECT_MAGNITUDES).toEqual({
        DAMAGE: { kind: 'FIXED_PERCENT', percent: 100 },
        CRITICAL_DAMAGE: { kind: 'PERCENT_RANGE', minPercent: 120, maxPercent: 180 },
        EVADE: { kind: 'FIXED_PERCENT', percent: 80 },
        RESIST: { kind: 'FIXED_PERCENT', percent: 60 },
        ESCAPE: { kind: 'FIXED_PERCENT', percent: 20 },
        NO_DAMAGE: { kind: 'FIXED_PERCENT', percent: 0 },
      })
    })

    it('el resultado no revela indice, fila ni semilla: solo efecto, magnitud y porcentaje', () => {
      expect(Object.keys(table.resolve(RandomIndex.create(1234))).sort()).toEqual([
        'effect',
        'magnitude',
        'percent',
      ])
    })

    it('el dominio rechaza indices fuera de 1..8000 antes de llegar a la tabla', () => {
      expect(() => RandomIndex.create(0)).toThrow(InvalidRandomIndexError)
      expect(() => RandomIndex.create(8001)).toThrow(InvalidRandomIndexError)
    })
  })

  describe('tablas con rangos de una sola fila y efectos ausentes', () => {
    it('acepta todo el espacio en un unico efecto (sin rangos vacios)', () => {
      const all = EffectControlTable.fromRowCounts(rows(0, 0, 0, 0, 0, 8000))

      expect(all.ranges).toEqual([{ effect: 'NO_DAMAGE', firstRow: 1, lastRow: 8000 }])
      expect(at(all, 1)).toBe(RandomEffectType.NoDamage)
      expect(at(all, 8000)).toBe(RandomEffectType.NoDamage)
    })

    it('resuelve correctamente un efecto de una sola fila', () => {
      const single = EffectControlTable.fromRowCounts(rows(1, 0, 0, 0, 0, 7999))

      expect(at(single, 1)).toBe(RandomEffectType.Damage)
      expect(at(single, 2)).toBe(RandomEffectType.NoDamage)
    })
  })

  describe('rechaza distribuciones invalidas sin corregirlas en silencio', () => {
    it.each([
      ['suma 7999', rows(4800, 400, 240, 0, 160, 2399), 7999],
      ['suma 8001', rows(4800, 400, 240, 0, 160, 2401), 8001],
      ['suma 0', rows(0, 0, 0, 0, 0, 0), 0],
    ])('%s', (_label, counts, total) => {
      expect(() => EffectControlTable.fromRowCounts(counts)).toThrow(
        IncompleteEffectDistributionError,
      )
      expect(() => EffectControlTable.fromRowCounts(counts)).toThrow(String(total))
    })

    it.each([
      ['filas negativas', rows(-1, 401, 240, 0, 160, 7200)],
      ['filas decimales', rows(4800.5, 399.5, 240, 0, 160, 2400)],
      ['NaN', rows(Number.NaN, 400, 240, 0, 160, 2400)],
      ['Infinity', rows(Number.POSITIVE_INFINITY, 0, 0, 0, 0, 0)],
    ])('%s', (_label, counts) => {
      expect(() => EffectControlTable.fromRowCounts(counts)).toThrow(InvalidEffectTableError)
    })

    it('un efecto ausente (JavaScript sin tipos) no se toma como 0', () => {
      const missing = { DAMAGE: 8000 } as unknown as EffectRowCounts

      expect(() => EffectControlTable.fromRowCounts(missing)).toThrow(InvalidEffectTableError)
    })

    it('un efecto desconocido no se ignora', () => {
      const extra = {
        ...rows(4800, 400, 240, 0, 160, 2400),
        STUN: 10,
      } as unknown as EffectRowCounts

      expect(() => EffectControlTable.fromRowCounts(extra)).toThrow(/STUN/)
    })
  })

  describe('inmutabilidad', () => {
    it('los rangos no se pueden alterar desde fuera', () => {
      const table = warriorWeapons()

      expect(Object.isFrozen(table.ranges)).toBe(true)
      expect(Object.isFrozen(table.ranges[0])).toBe(true)
    })

    it('la tabla no depende del objeto de filas con el que se construyo', () => {
      const counts = { ...rows(4800, 400, 240, 0, 160, 2400) }
      const table = EffectControlTable.fromRowCounts(counts)

      counts.DAMAGE = 1

      expect(table.rowsOf(RandomEffectType.Damage)).toBe(4800)
    })
  })
})
