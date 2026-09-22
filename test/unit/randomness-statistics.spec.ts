import { BoxMullerNormalGenerator } from '../../src/adapters/outbound/system/BoxMullerNormalGenerator'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937 } from '../../src/adapters/outbound/system/Mt19937'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

/**
 * Validacion estadistica AUTOMATIZADA de HU-24 (deteccion de fallos evidentes,
 * NO el estudio cientifico completo: KS, Ljung-Box, Q-Q y seleccion de semilla
 * pertenecen a HU-26).
 *
 * Por que NO es flaky: la semilla es fija, no interviene reloj ni `Math.random`
 * y la secuencia es deterministica, asi que cada estadistico es SIEMPRE el
 * mismo numero. Los umbrales se justifican abajo y se eligieron tras medir
 * varias semillas, con margen.
 */
const SEED = RandomSeed.create(3_000_000)
const SAMPLE_SIZE = 200_000
const BIN_WIDTH = 100
const BIN_COUNT = 80

describe('Validacion estadistica del indice 1..8000 (semilla fija 3.000.000)', () => {
  const sequence = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper()).create(
    SEED,
  )
  const bins = new Array<number>(BIN_COUNT).fill(0)
  let inFirst4800 = 0
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY

  beforeAll(() => {
    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const { value } = sequence.nextIndex()
      const bin = Math.floor((value - 1) / BIN_WIDTH)

      bins[bin] = (bins[bin] ?? 0) + 1
      inFirst4800 += value <= 4800 ? 1 : 0
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
  })

  it('cubre todo el rango 1..8000 sin salirse de el', () => {
    expect(minimum).toBe(1)
    expect(maximum).toBe(8000)
  })

  it('chi-cuadrado de uniformidad (80 bins de 100 filas) por debajo del critico alfa = 0,001', () => {
    // Esperado por bin: 200.000 / 80 = 2.500. Grados de libertad: 79. Critico
    // chi2(0,999; 79) = 123,594 (scipy.stats.chi2.isf(0.001, 79)). Medido con
    // esta semilla: ~105,0. Otras semillas probadas (0, 1, 42, 777, 123456789)
    // dieron entre 59 y 108: ninguna cerca del umbral.
    const expected = SAMPLE_SIZE / BIN_COUNT
    const chiSquare = bins.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0)

    expect(chiSquare).toBeLessThan(123.594)
  })

  it('las 4800 primeras filas reciben ~60 % de las tiradas, no ~72,6 %', () => {
    // 4800 de 8000 filas = 60 % (ejemplo oficial de HU-25). Con la normal usada
    // directamente como indice serian ~72,4-72,6 %. Desviacion tipica de la
    // proporcion con n = 200.000: 0,11 puntos; la tolerancia de 1 punto es
    // ~9 sigma, y esta a 11 puntos de distancia del hallazgo que se evita.
    expect(inFirst4800 / SAMPLE_SIZE).toBeCloseTo(0.6, 2)
    expect(Math.abs(inFirst4800 / SAMPLE_SIZE - 0.6)).toBeLessThan(0.01)
  })

  it('no hay concentracion central: el bin central no supera al de los extremos por mas de un 15 %', () => {
    // Con la normal directa, el bin central tendria ~2,5x el de los extremos.
    const central = bins[BIN_COUNT / 2] ?? 0
    const firstEdge = bins[0] ?? 0
    const lastEdge = bins[BIN_COUNT - 1] ?? 0

    expect(central / firstEdge).toBeLessThan(1.15)
    expect(central / lastEdge).toBeLessThan(1.15)
    expect(firstEdge / central).toBeLessThan(1.15)
  })
})

describe('Validacion de la etapa normal (Box-Muller sobre MT19937, semilla fija)', () => {
  it('media ~0 y desviacion tipica ~1 sobre 100.000 valores', () => {
    const normals = new BoxMullerNormalGenerator(new Mt19937(SEED))
    const count = 100_000
    let sum = 0
    let sumSquares = 0

    for (let i = 0; i < count; i += 1) {
      const z = normals.nextNormal()
      sum += z
      sumSquares += z * z
    }

    const mean = sum / count
    const standardDeviation = Math.sqrt(sumSquares / count - mean * mean)

    // Error tipico de la media: 1/sqrt(1e5) = 0,0032; tolerancia 0,02 (~6 sigma).
    expect(Math.abs(mean)).toBeLessThan(0.02)
    expect(Math.abs(standardDeviation - 1)).toBeLessThan(0.02)
  })
})
