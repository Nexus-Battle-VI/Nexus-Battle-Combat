import { BoxMullerNormalGenerator } from '../../src/adapters/outbound/system/BoxMullerNormalGenerator'
import { Mt19937 } from '../../src/adapters/outbound/system/Mt19937'
import type { UniformSource } from '../../src/adapters/outbound/system/RandomnessContracts'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

/**
 * Fuente uniforme DETERMINISTA y observable: devuelve los valores dados en
 * orden y cuenta cuantos uniformes se consumieron. Permite probar Box-Muller
 * sin Mersenne Twister.
 */
class ScriptedSource implements UniformSource {
  consumed = 0

  constructor(private readonly values: readonly number[]) {}

  nextDouble(): number {
    const value = this.values[this.consumed]
    this.consumed += 1

    if (value === undefined) {
      throw new Error('La fuente de prueba se quedo sin valores.')
    }

    return value
  }
}

describe('BoxMullerNormalGenerator', () => {
  describe('la transformacion', () => {
    it('R = sqrt(-2 ln U1), t = 2 pi U2: Z0 = R cos t y Z1 = R sin t', () => {
      // U1 = e^-2 => R = 2. U2 = 1/8 => t = pi/4 => cos = sin = sqrt(2)/2.
      const generator = new BoxMullerNormalGenerator(new ScriptedSource([Math.exp(-2), 0.125]))

      expect(generator.nextNormal()).toBeCloseTo(Math.SQRT2, 12)
      expect(generator.nextNormal()).toBeCloseTo(Math.SQRT2, 12)
    })

    it('U2 = 0 da Z0 = R y Z1 = 0; U2 = 0.25 da Z0 = 0 y Z1 = R', () => {
      const primero = new BoxMullerNormalGenerator(new ScriptedSource([Math.exp(-2), 0]))
      expect(primero.nextNormal()).toBeCloseTo(2, 12)
      expect(primero.nextNormal()).toBeCloseTo(0, 12)

      const segundo = new BoxMullerNormalGenerator(new ScriptedSource([Math.exp(-2), 0.25]))
      expect(segundo.nextNormal()).toBeCloseTo(0, 12)
      expect(segundo.nextNormal()).toBeCloseTo(2, 12)
    })
  })

  describe('aprovecha AMBAS variables (Z0 y Z1)', () => {
    it('consume dos uniformes por cada dos normales, no cuatro', () => {
      const source = new ScriptedSource([0.3, 0.6, 0.7, 0.2])
      const generator = new BoxMullerNormalGenerator(source)

      generator.nextNormal()
      expect(source.consumed).toBe(2)

      // Z1 pendiente: NO se generan nuevos U1/U2.
      generator.nextNormal()
      expect(source.consumed).toBe(2)

      // Agotada la pareja, la tercera llamada abre una nueva.
      generator.nextNormal()
      expect(source.consumed).toBe(4)
    })

    it('la segunda llamada devuelve exactamente el Z1 de la primera pareja', () => {
      const u1 = 0.3
      const u2 = 0.6
      const generator = new BoxMullerNormalGenerator(new ScriptedSource([u1, u2]))
      const radius = Math.sqrt(-2 * Math.log(u1))

      generator.nextNormal()

      expect(generator.nextNormal()).toBe(radius * Math.sin(2 * Math.PI * u2))
    })
  })

  describe('robustez numerica', () => {
    it('U1 = 0 no produce log(0): el resultado es finito', () => {
      const generator = new BoxMullerNormalGenerator(new ScriptedSource([0, 0.25]))

      const z0 = generator.nextNormal()
      const z1 = generator.nextNormal()

      expect(Number.isFinite(z0)).toBe(true)
      expect(Number.isFinite(z1)).toBe(true)
      // Con Number.MIN_VALUE, R = sqrt(-2 ln(5e-324)) ~ 38,6.
      expect(z1).toBeCloseTo(Math.sqrt(-2 * Math.log(Number.MIN_VALUE)), 9)
    })

    it.each([Number.NaN, 1, 1.5, -0.1, Number.POSITIVE_INFINITY])(
      'rechaza una fuente que devuelve %p (fuera de [0, 1))',
      (bad) => {
        expect(() =>
          new BoxMullerNormalGenerator(new ScriptedSource([bad, 0.5])).nextNormal(),
        ).toThrow(RangeError)
        expect(() =>
          new BoxMullerNormalGenerator(new ScriptedSource([0.5, bad])).nextNormal(),
        ).toThrow(RangeError)
      },
    )

    it('no produce NaN ni Infinity con Mersenne Twister real', () => {
      const generator = new BoxMullerNormalGenerator(new Mt19937(RandomSeed.create(3_000_000)))

      for (let i = 0; i < 50_000; i += 1) {
        expect(Number.isFinite(generator.nextNormal())).toBe(true)
      }
    })
  })

  describe('determinismo', () => {
    it('una fuente determinista produce siempre las mismas normales', () => {
      const values = [0.11, 0.22, 0.33, 0.44, 0.55, 0.66]
      const a = new BoxMullerNormalGenerator(new ScriptedSource(values))
      const b = new BoxMullerNormalGenerator(new ScriptedSource(values))

      const sequence = (g: BoxMullerNormalGenerator): number[] =>
        Array.from({ length: 6 }, () => g.nextNormal())

      expect(sequence(a)).toEqual(sequence(b))
    })

    it('no serializa su estado (la normal pendiente)', () => {
      const generator = new BoxMullerNormalGenerator(new ScriptedSource([0.3, 0.6]))
      generator.nextNormal()

      expect(JSON.stringify(generator)).toBe('{}')
    })
  })
})
