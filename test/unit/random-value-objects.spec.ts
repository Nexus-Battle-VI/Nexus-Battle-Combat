import {
  InvalidRandomIndexError,
  InvalidRandomSeedError,
} from '../../src/domain/errors/RandomnessErrors'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

describe('RandomIndex', () => {
  it('acepta todo entero de 1 a 8000, incluidos los extremos', () => {
    for (let value = RandomIndex.MIN; value <= RandomIndex.MAX; value += 1) {
      expect(RandomIndex.create(value).value).toBe(value)
    }
  })

  it('la tabla de control tiene exactamente 8000 filas', () => {
    expect(RandomIndex.MIN).toBe(1)
    expect(RandomIndex.MAX).toBe(8000)
  })

  it.each([0, 8001, -1, 1.5, 4000.0001, Number.NaN, Number.POSITIVE_INFINITY, -Infinity])(
    'rechaza %p',
    (raw) => {
      expect(() => RandomIndex.create(raw)).toThrow(InvalidRandomIndexError)
    },
  )

  it.each(['1', null, undefined, {}, [1], true])('rechaza el valor no numerico %p', (raw) => {
    expect(() => RandomIndex.create(raw)).toThrow(InvalidRandomIndexError)
  })

  it('compara por valor y se representa como texto', () => {
    expect(RandomIndex.create(4001).equals(RandomIndex.create(4001))).toBe(true)
    expect(RandomIndex.create(4001).equals(RandomIndex.create(4002))).toBe(false)
    expect(RandomIndex.create(4001).toString()).toBe('4001')
  })
})

describe('RandomSeed', () => {
  it.each([0, 1, 42, 3_000_000, 4_294_967_295])('acepta la semilla uint32 %p', (raw) => {
    expect(RandomSeed.create(raw).value).toBe(raw)
  })

  it.each([-1, 4_294_967_296, 7_294_967_295, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rechaza %p (no es uint32)',
    (raw) => {
      expect(() => RandomSeed.create(raw)).toThrow(InvalidRandomSeedError)
    },
  )

  it.each(['3000000', null, undefined, 10n])('rechaza el valor no numerico %p', (raw) => {
    expect(() => RandomSeed.create(raw)).toThrow(InvalidRandomSeedError)
  })
})
