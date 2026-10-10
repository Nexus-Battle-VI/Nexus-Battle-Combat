import {
  assertUint32Seed,
  deriveCombatSeed,
  deriveMctsSeed,
  deriveRandomPolicySeed,
  deriveTurnOrderSeed,
  generateSeedSequence,
} from '../../src/evaluation/experiment/EvaluationSeedSchedule'

describe('EvaluationSeedSchedule (EN-036.5, Management #569 §25-29)', () => {
  it('es determinista: misma entrada -> misma salida', () => {
    expect(deriveCombatSeed(42)).toBe(deriveCombatSeed(42))
    expect(deriveRandomPolicySeed(42, 'A')).toBe(deriveRandomPolicySeed(42, 'A'))
    expect(deriveMctsSeed(42, 'A', 3)).toBe(deriveMctsSeed(42, 'A', 3))
  })

  it('separa namespaces: combat/turn-order/random-policy nunca coinciden para el mismo matchSeed', () => {
    const matchSeed = 777
    const seeds = new Set([
      deriveCombatSeed(matchSeed),
      deriveTurnOrderSeed(matchSeed),
      deriveRandomPolicySeed(matchSeed, 'A'),
      deriveRandomPolicySeed(matchSeed, 'B'),
    ])

    expect(seeds.size).toBe(4)
  })

  it('separa por lado (A vs B) con el mismo matchSeed', () => {
    expect(deriveRandomPolicySeed(1, 'A')).not.toBe(deriveRandomPolicySeed(1, 'B'))
  })

  it('MCTS deriva una semilla NUEVA por decisionIndex (#569 §28: nunca repetir simulationSeed)', () => {
    const seeds = Array.from({ length: 10 }, (_, i) => deriveMctsSeed(1, 'A', i))
    expect(new Set(seeds).size).toBe(10)
  })

  it('todas las semillas derivadas son uint32 validos', () => {
    const seed = deriveMctsSeed(99, 'B', 500)
    expect(() => assertUint32Seed(seed, 'seed')).not.toThrow()
  })

  it('assertUint32Seed rechaza negativos, no enteros y valores fuera de rango', () => {
    expect(() => assertUint32Seed(-1, 'x')).toThrow(RangeError)
    expect(() => assertUint32Seed(1.5, 'x')).toThrow(RangeError)
    expect(() => assertUint32Seed(0x1_0000_0000, 'x')).toThrow(RangeError)
    expect(() => assertUint32Seed(0, 'x')).not.toThrow()
    expect(() => assertUint32Seed(0xffff_ffff, 'x')).not.toThrow()
  })

  it('generateSeedSequence produce una secuencia determinista contigua', () => {
    expect(generateSeedSequence(3_000_000, 5)).toEqual([
      3_000_000, 3_000_001, 3_000_002, 3_000_003, 3_000_004,
    ])
  })

  it('generateSeedSequence rechaza seedCount < 1', () => {
    expect(() => generateSeedSequence(0, 0)).toThrow(RangeError)
  })
})
