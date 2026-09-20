import { BoxMullerNormalGenerator } from '../../src/adapters/outbound/system/BoxMullerNormalGenerator'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937 } from '../../src/adapters/outbound/system/Mt19937'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

/**
 * GOLDEN TESTS de HU-24.
 *
 * Su unico objetivo es detectar un cambio INVOLUNTARIO futuro en cualquiera de
 * las cuatro etapas: inicializacion, MT19937, Box-Muller o mapeo. Si alguno
 * falla, algo cambio en la secuencia que ve el resto del sistema: NO se
 * "actualizan" los valores sin entender por que.
 *
 * Origen de los valores (ninguno es inventado a mano):
 *  1. Se generaron con esta implementacion productiva.
 *  2. Se contrastaron con un oraculo INDEPENDIENTE en Python 3.13 / NumPy 2.4.2 /
 *     SciPy 1.17.0:
 *       - uint32 y uniformes de 53 bits: identicos bit a bit a
 *         `np.random.RandomState(seed)` (inicializacion `init_genrand`).
 *       - normales: Box-Muller reimplementado en Python (dif. maxima 1,1e-16).
 *       - indices: `floor(scipy.special.ndtr(Z) * 8000) + 1` (identicos).
 *
 * IMPORTANTE: la equivalencia demostrada es con `RandomState(seed)`. NO se
 * afirma que la secuencia coincida con `np.random.MT19937(seed)` /
 * `default_rng(seed)` (SeedSequence), que produce otra distinta. La validacion
 * del generador productivo frente al estudio de semillas es alcance de HU-26.
 */
describe('Golden: secuencia productiva de HU-24', () => {
  describe('semilla 3.000.000 (candidata del estudio, usada solo como fixture)', () => {
    const seed = RandomSeed.create(3_000_000)

    it('MT19937: diez primeras salidas uint32', () => {
      const mt = new Mt19937(seed)

      expect(Array.from({ length: 10 }, () => mt.nextUint32())).toEqual([
        3860895593, 2004487413, 2370801471, 2009496479, 980264933, 2775125586, 1131123253,
        1857295098, 2180828474, 2087201783,
      ])
    })

    it('Box-Muller: seis primeras normales (Z0, Z1, Z0, Z1, Z0, Z1)', () => {
      const normals = new BoxMullerNormalGenerator(new Mt19937(seed))
      const expected = [
        -0.43720037393349565, -0.1481396670342545, -0.144125791425559, 1.7128865736876675,
        1.161409574171299, 0.08127739813106132,
      ]

      expected.forEach((value) => {
        expect(normals.nextNormal()).toBeCloseTo(value, 12)
      })
    })

    it('secuencia completa: diez primeros indices 1..8000', () => {
      const sequence = new Mt19937BoxMullerRandomSequenceFactory(
        new CdfUniformIndexMapper(),
      ).create(seed)

      expect(Array.from({ length: 10 }, () => sequence.nextIndex().value)).toEqual([
        2648, 3529, 3542, 7654, 7019, 4260, 2553, 5830, 2324, 6027,
      ])
    })
  })

  describe('semilla 5489 (por defecto del MT19937 de referencia)', () => {
    const seed = RandomSeed.create(5489)

    it('Box-Muller: seis primeras normales', () => {
      const normals = new BoxMullerNormalGenerator(new Mt19937(seed))
      const expected = [
        0.5312527637338801, -0.3571876505133358, 1.7380276692681627, -1.0519523915593638,
        0.7831484150238519, 0.550703003042475,
      ]

      expected.forEach((value) => {
        expect(normals.nextNormal()).toBeCloseTo(value, 12)
      })
    })

    it('secuencia completa: diez primeros indices 1..8000', () => {
      const sequence = new Mt19937BoxMullerRandomSequenceFactory(
        new CdfUniformIndexMapper(),
      ).create(seed)

      expect(Array.from({ length: 10 }, () => sequence.nextIndex().value)).toEqual([
        5620, 2884, 7672, 1172, 6266, 5673, 504, 2570, 4906, 3795,
      ])
    })
  })
})
