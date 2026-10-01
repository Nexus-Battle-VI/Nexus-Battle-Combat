import { resolveVersusDrop } from '../../src/application/services/ResolveVersusDrop'
import type { VersusDropCandidate } from '../../src/domain/entities/VersusDrop'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'

const candidate = (id: string, chance: number): VersusDropCandidate => ({
  productInstanceId: id,
  productId: `product-${id}`,
  itemId: `item-${id}`,
  dropChanceBasisPoints: chance,
})

class ScriptedSequence implements RandomSequencePort {
  calls = 0
  constructor(private readonly values: readonly number[]) {}

  nextIndex(): RandomIndex {
    const value = this.values[this.calls]
    this.calls += 1
    if (value === undefined) throw new Error('Falta índice de prueba.')
    return RandomIndex.create(value)
  }
}

describe('HU-30: resolución individual con RNG central', () => {
  it('evalúa todas las piezas; ninguna elegible produce NO_DROP', () => {
    const sequence = new ScriptedSequence([1, 2, 1, 3])
    const result = resolveVersusDrop([candidate('a', 0), candidate('b', 2)], sequence)
    expect(result.status).toBe('NO_DROP')
    expect(result.evaluations.map((entry) => entry.rollBasisPoints)).toEqual([1, 2])
    expect(sequence.calls).toBe(4)
  })

  it('elige la tasa mayor solo DESPUÉS de evaluar individualmente', () => {
    const sequence = new ScriptedSequence([1, 1, 1, 1, 1, 999])
    const result = resolveVersusDrop(
      [candidate('low', 100), candidate('high', 500), candidate('failed', 1)],
      sequence,
    )
    expect(result.status).toBe('PENDING')
    if (result.status !== 'PENDING') throw new Error('Se esperaba un drop pendiente.')
    expect(result.selected.productInstanceId).toBe('high')
    expect(result.evaluations.map((entry) => entry.eligible)).toEqual([true, true, false])
    expect(sequence.calls).toBe(6)
  })

  it('deja empate máximo pendiente, sin elegir por orden', () => {
    const sequence = new ScriptedSequence([1, 1, 1, 1])
    expect(resolveVersusDrop([candidate('a', 500), candidate('b', 500)], sequence).status).toBe(
      'AWAITING_TIE_RULE',
    )
  })

  it('representa exactamente 0 % y 100 %', () => {
    const sequence = new ScriptedSequence([1, 1, 8000, 8000])
    const result = resolveVersusDrop([candidate('zero', 0), candidate('certain', 10000)], sequence)
    expect(result.status).toBe('PENDING')
    expect(result.evaluations.map((entry) => entry.eligible)).toEqual([false, true])
  })

  it('rechaza tasas ausentes o identidades duplicadas antes de tirar', () => {
    const sequence = new ScriptedSequence([])
    expect(() => resolveVersusDrop([candidate('x', Number.NaN)], sequence)).toThrow()
    expect(() => resolveVersusDrop([candidate('x', 10), candidate('x', 20)], sequence)).toThrow()
    expect(sequence.calls).toBe(0)
  })
})
