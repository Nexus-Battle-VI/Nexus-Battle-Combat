import { standardNormalCdf } from '../../src/adapters/outbound/system/StandardNormalCdf'

/**
 * Valores de referencia generados con `scipy.special.ndtr` (SciPy 1.17.0,
 * doble precision). No son inventados ni aproximados a mano.
 */
const SCIPY_NDTR: readonly (readonly [number, number])[] = [
  [-8, 6.22096057427174e-16],
  [-6, 9.865876450376948e-10],
  [-5, 2.8665157187919333e-7],
  [-4, 3.167124183311986e-5],
  [-3, 0.001349898031630093],
  [-2, 0.0227501319481792],
  [-1, 0.15865525393145707],
  [-0.5, 0.3085375387259869],
  [0, 0.5],
  [0.5, 0.6914624612740131],
  [1, 0.8413447460685429],
  [2, 0.9772498680518208],
  [3, 0.9986501019683699],
  [4, 0.9999683287581669],
  [5, 0.9999997133484281],
  [6, 0.9999999990134123],
  [8, 0.9999999999999993],
]

/** Rejilla fina simetrica de -9 a 9 en pasos de 0,01. */
const GRID: readonly number[] = Array.from({ length: 1801 }, (_, i) => -900 + i).map((n) => n / 100)

describe('standardNormalCdf', () => {
  it('Phi(0) = 0,5', () => {
    expect(standardNormalCdf(0)).toBeCloseTo(0.5, 15)
  })

  it.each(SCIPY_NDTR)('Phi(%p) coincide con scipy.special.ndtr', (z, expected) => {
    expect(Math.abs(standardNormalCdf(z) - expected)).toBeLessThan(1e-14)
  })

  it('los cuantiles clasicos 1,96 y 2,576 dan 0,975 y 0,995', () => {
    expect(standardNormalCdf(1.959963984540054)).toBeCloseTo(0.975, 12)
    expect(standardNormalCdf(2.5758293035489004)).toBeCloseTo(0.995, 12)
  })

  it('es simetrica: Phi(-x) = 1 - Phi(x)', () => {
    for (const z of GRID.filter((value) => value >= 0)) {
      expect(standardNormalCdf(-z) + standardNormalCdf(z)).toBeCloseTo(1, 14)
    }
  })

  it('es monotona no decreciente en toda la rejilla', () => {
    let previous = standardNormalCdf(GRID[0] ?? -9)

    for (const z of GRID.slice(1)) {
      const current = standardNormalCdf(z)

      // Holgura de 1e-15: una aproximacion por tramos admite saltos de 1 ULP en
      // la frontera entre tramos (|z| = 7,07).
      expect(current).toBeGreaterThanOrEqual(previous - 1e-15)
      previous = current
    }
  })

  it('el resultado siempre esta en [0, 1], tambien en valores extremos', () => {
    const extremes = [
      -1e10,
      -40,
      -37.5,
      -8.5,
      8.5,
      37.5,
      40,
      1e10,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]

    for (const z of [...extremes, ...GRID]) {
      const value = standardNormalCdf(z)

      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('satura a 0 y a 1 en +-Infinity', () => {
    expect(standardNormalCdf(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(standardNormalCdf(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('rechaza NaN en lugar de propagarlo', () => {
    expect(() => standardNormalCdf(Number.NaN)).toThrow(RangeError)
  })
})
