import { InvalidRewardTableError } from '../../src/domain/errors/RewardTableErrors'
import { RewardTable, type RewardEntry } from '../../src/domain/reward/RewardTable'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import {
  buildRewardTable,
  REWARD_TABLE_ENTRIES,
  REWARD_TABLE_ROWS,
} from '../../src/infrastructure/config/reward-table'

const entry = (productId: string): RewardEntry => ({
  productId,
  sku: `${productId}-sku`,
  name: productId,
  tierId: 'TEST',
})

describe('RewardTable', () => {
  it('resuelve el producto de un tramo dado', () => {
    const table = RewardTable.fromRanges([
      { firstRow: 1, lastRow: 4800, entry: entry('a') },
      { firstRow: 4801, lastRow: 7200, entry: entry('b') },
      { firstRow: 7201, lastRow: 8000, entry: entry('c') },
    ])

    expect(table.resolve(RandomIndex.create(1)).productId).toBe('a')
    expect(table.resolve(RandomIndex.create(4800)).productId).toBe('a')
    expect(table.resolve(RandomIndex.create(4801)).productId).toBe('b')
    expect(table.resolve(RandomIndex.create(7200)).productId).toBe('b')
    expect(table.resolve(RandomIndex.create(7201)).productId).toBe('c')
    expect(table.resolve(RandomIndex.create(8000)).productId).toBe('c')
  })

  it('rechaza un hueco entre tramos', () => {
    expect(() =>
      RewardTable.fromRanges([
        { firstRow: 1, lastRow: 100, entry: entry('a') },
        { firstRow: 102, lastRow: 8000, entry: entry('b') },
      ]),
    ).toThrow(InvalidRewardTableError)
  })

  it('rechaza un solape entre tramos', () => {
    expect(() =>
      RewardTable.fromRanges([
        { firstRow: 1, lastRow: 100, entry: entry('a') },
        { firstRow: 90, lastRow: 8000, entry: entry('b') },
      ]),
    ).toThrow(InvalidRewardTableError)
  })

  it('rechaza una tabla que no cubre exactamente 1..8000', () => {
    expect(() =>
      RewardTable.fromRanges([{ firstRow: 1, lastRow: 7999, entry: entry('a') }]),
    ).toThrow(InvalidRewardTableError)
  })

  it('rechaza una tabla vacia', () => {
    expect(() => RewardTable.fromRanges([])).toThrow(InvalidRewardTableError)
  })

  it('el orden de entrada no importa: se ordena por firstRow', () => {
    const table = RewardTable.fromRanges([
      { firstRow: 4001, lastRow: 8000, entry: entry('segundo') },
      { firstRow: 1, lastRow: 4000, entry: entry('primero') },
    ])

    expect(table.resolve(RandomIndex.create(1)).productId).toBe('primero')
    expect(table.resolve(RandomIndex.create(8000)).productId).toBe('segundo')
  })
})

describe('reward table embebida de HU-22 (config real)', () => {
  it('cubre exactamente 1..8000 con 40 productos, sin huecos ni solapes', () => {
    expect(REWARD_TABLE_ROWS).toBe(RandomIndex.MAX)
    expect(REWARD_TABLE_ENTRIES).toHaveLength(40)

    // fromRanges() ya valida cobertura total; que no lance es la prueba.
    expect(() => buildRewardTable()).not.toThrow()
  })

  it('16 ARMADURA de 300 filas, 16 ARMA de 150, 8 ITEM de 100 (60/30/10 %)', () => {
    const byTier = new Map<string, number>()

    for (const config of REWARD_TABLE_ENTRIES) {
      byTier.set(
        config.tierId,
        (byTier.get(config.tierId) ?? 0) + (config.lastRow - config.firstRow + 1),
      )
    }

    expect(byTier.get('COMUN')).toBe(4800)
    expect(byTier.get('RARA')).toBe(2400)
    expect(byTier.get('ESPECIAL')).toBe(800)
  })

  it('cada productId es un UUID real y unico', () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const seen = new Set<string>()

    for (const config of REWARD_TABLE_ENTRIES) {
      expect(config.productId).toMatch(uuidPattern)
      expect(seen.has(config.productId)).toBe(false)
      seen.add(config.productId)
    }
  })

  it('resuelve el primer y el ultimo indice de la tabla real', () => {
    const table = buildRewardTable()

    expect(table.resolve(RandomIndex.create(1)).name).toBe('Atadura carmesí')
    expect(table.resolve(RandomIndex.create(8000)).name).toBe('Veneno lacerante')
  })
})
