import { deriveMctsRolloutSeed } from '../../src/domain/policies/MctsSeedDerivation'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { InvalidMctsConfigError } from '../../src/domain/errors/MctsErrors'

describe('deriveMctsRolloutSeed (EN-036.1)', () => {
  it('es determinista: la misma raiz e indice siempre derivan la misma semilla', () => {
    const first = deriveMctsRolloutSeed(3_000_000, 7)
    const second = deriveMctsRolloutSeed(3_000_000, 7)

    expect(first.value).toBe(second.value)
  })

  it('indices distintos derivan semillas distintas (sin colisiones en un rango pequeno)', () => {
    const seeds = new Set<number>()
    for (let index = 0; index < 256; index += 1) {
      seeds.add(deriveMctsRolloutSeed(3_000_000, index).value)
    }

    expect(seeds.size).toBe(256)
  })

  it('raices distintas con el mismo indice derivan semillas distintas', () => {
    const fromRootA = deriveMctsRolloutSeed(1, 0)
    const fromRootB = deriveMctsRolloutSeed(2, 0)

    expect(fromRootA.value).not.toBe(fromRootB.value)
  })

  it('la semilla derivada siempre es un RandomSeed valido (uint32)', () => {
    const seed = deriveMctsRolloutSeed(0xffff_ffff, 999)

    expect(() => RandomSeed.create(seed.value)).not.toThrow()
  })

  it('rechaza un indice de rollout invalido', () => {
    expect(() => deriveMctsRolloutSeed(3_000_000, -1)).toThrow(InvalidMctsConfigError)
    expect(() => deriveMctsRolloutSeed(3_000_000, 1.5)).toThrow(InvalidMctsConfigError)
  })
})
