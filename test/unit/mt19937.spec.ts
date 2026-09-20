import { Mt19937 } from '../../src/adapters/outbound/system/Mt19937'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

const generator = (seed: number): Mt19937 => new Mt19937(RandomSeed.create(seed))

const take = (source: Mt19937, count: number): number[] =>
  Array.from({ length: count }, () => source.nextUint32())

/**
 * MT19937 (HU-24 / RF-24). Los vectores de esta suite NO son inventados:
 *
 *  - Semilla 5489 (la por defecto del codigo de referencia `mt19937ar.c` y de
 *    `std::mt19937`): las cinco primeras salidas y la salida numero 10.000
 *    (4123659995) son las publicadas por la norma C++ y por Matsumoto/Nishimura.
 *  - Semilla 3.000.000: contrastada BIT A BIT con NumPy 2.4.2
 *    (`np.random.MT19937()._legacy_seeding(3000000).random_raw(n)`, es decir
 *    `RandomState(3000000)`), que usa la misma inicializacion `init_genrand`.
 *    Esto NO demuestra equivalencia con `np.random.MT19937(3000000)` /
 *    `default_rng` (SeedSequence), que produce OTRA secuencia.
 */
describe('Mt19937', () => {
  describe('vectores publicados (semilla 5489)', () => {
    it('produce las cinco primeras salidas del codigo de referencia', () => {
      expect(take(generator(5489), 5)).toEqual([
        3499211612, 581869302, 3890346734, 3586334585, 545404204,
      ])
    })

    it('la salida numero 10.000 es 4123659995 (norma C++ para std::mt19937)', () => {
      const source = generator(5489)
      let tenThousandth = 0

      for (let i = 0; i < 10_000; i += 1) {
        tenThousandth = source.nextUint32()
      }

      expect(tenThousandth).toBe(4123659995)
    })
  })

  describe('contraste con NumPy RandomState (semilla 3.000.000)', () => {
    it('reproduce las diez primeras salidas uint32', () => {
      expect(take(generator(3_000_000), 10)).toEqual([
        3860895593, 2004487413, 2370801471, 2009496479, 980264933, 2775125586, 1131123253,
        1857295098, 2180828474, 2087201783,
      ])
    })

    it('reproduce los uniformes de 53 bits de RandomState.random_sample', () => {
      const source = generator(3_000_000)

      expect(Array.from({ length: 6 }, () => source.nextDouble())).toEqual([
        0.8989348073803342, 0.5519952287366416, 0.22823571895162964, 0.2633601533802986,
        0.5077636948672274, 0.011119801784900463,
      ])
    })
  })

  describe('determinismo y estado', () => {
    it('la misma semilla produce exactamente la misma secuencia', () => {
      // 2.000 > 3 bloques de 624: incluye varias regeneraciones del estado.
      expect(take(generator(42), 2_000)).toEqual(take(generator(42), 2_000))
    })

    it('semillas distintas producen secuencias distintas', () => {
      expect(take(generator(1), 10)).not.toEqual(take(generator(2), 10))
    })

    it('el estado avanza: una llamada no repite a la anterior ni reinicia la secuencia', () => {
      const source = generator(7)
      const values = take(source, 5_000)

      // Un generador reinicializado en cada llamada repetiria el primer valor.
      expect(new Set(values).size).toBeGreaterThan(4_990)
      expect(values[1]).not.toBe(values[0])
    })

    it('dos instancias con la misma semilla son independientes entre si', () => {
      const a = generator(99)
      const b = generator(99)

      take(a, 700)

      // `b` no vio avanzar a `a`: sigue en el primer valor.
      expect(b.nextUint32()).toBe(generator(99).nextUint32())
    })

    it('todas las salidas son enteros uint32', () => {
      for (const value of take(generator(123), 3_000)) {
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(0xffff_ffff)
      }
    })

    it('acepta las semillas frontera 0 y 4294967295', () => {
      expect(take(generator(0), 3)).toHaveLength(3)
      expect(take(generator(4_294_967_295), 3)).toHaveLength(3)
    })
  })

  describe('uniforme de 53 bits', () => {
    it('siempre esta en [0, 1)', () => {
      const source = generator(2026)

      for (let i = 0; i < 20_000; i += 1) {
        const value = source.nextDouble()

        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThan(1)
      }
    })

    it('combina DOS salidas uint32 como genrand_res53 (27 + 26 bits)', () => {
      const reference = generator(2026)
      const source = generator(2026)

      const high = reference.nextUint32() >>> 5
      const low = reference.nextUint32() >>> 6

      expect(source.nextDouble()).toBe((high * 67_108_864 + low) / 9_007_199_254_740_992)
    })
  })

  describe('el estado no es visible desde fuera', () => {
    it('no se serializa ni enumera', () => {
      const source = generator(5489)
      source.nextUint32()

      expect(JSON.stringify(source)).toBe('{}')
      expect(Object.keys(source)).toEqual([])
    })
  })
})
