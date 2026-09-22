import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'

/**
 * Estrategia PROVISIONAL normal -> indice (decision tecnica de HU-24). Estas
 * pruebas fijan sus garantias: rango 1..8000 por construccion, monotonia y
 * defensa del limite superior.
 */
describe('CdfUniformIndexMapper', () => {
  const mapper = new CdfUniformIndexMapper()

  it('la mediana de la normal (Z = 0) cae en la fila central 4001', () => {
    // U = 0,5 -> floor(0,5 * 8000) + 1 = 4001.
    expect(mapper.map(0).value).toBe(4001)
  })

  it('las colas extremas se mapean a los extremos de la tabla, no fuera de ella', () => {
    expect(mapper.map(Number.NEGATIVE_INFINITY).value).toBe(1)
    expect(mapper.map(-10).value).toBe(1)
    expect(mapper.map(10).value).toBe(8000)
    expect(mapper.map(Number.POSITIVE_INFINITY).value).toBe(8000)
  })

  it('defiende el limite superior: Phi satura a 1 y aun asi el indice es 8000, no 8001', () => {
    // Cota mas alta que puede producir Box-Muller con MT (U1 = 2^-53): Z ~ 8,57.
    const highestReachable = Math.sqrt(-2 * Math.log(2 ** -53))

    expect(mapper.map(highestReachable).value).toBe(8000)
  })

  it('devuelve siempre un entero entre 1 y 8000 en una rejilla de Z de -12 a 12', () => {
    for (let z = -12; z <= 12; z += 0.001) {
      const { value } = mapper.map(z)

      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(1)
      expect(value).toBeLessThanOrEqual(8000)
    }
  })

  it('es monotona: una Z mayor nunca produce un indice menor', () => {
    let previous = 0

    for (let z = -6; z <= 6; z += 0.0005) {
      const { value } = mapper.map(z)

      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })

  it('es simetrica alrededor de la mediana: Z y -Z suman 8001 (salvo empate exacto)', () => {
    for (const z of [0.1, 0.5, 1, 1.5, 2, 3]) {
      expect(mapper.map(z).value + mapper.map(-z).value).toBeGreaterThanOrEqual(8000)
      expect(mapper.map(z).value + mapper.map(-z).value).toBeLessThanOrEqual(8002)
    }
  })

  it('rechaza NaN en lugar de producir un indice basura', () => {
    expect(() => mapper.map(Number.NaN)).toThrow(RangeError)
  })
})
