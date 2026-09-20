import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  NormalSequencePort,
  RandomSequenceFactoryPort,
  RandomSequencePort,
} from '../../src/application/ports/RandomSequencePort'
import { InvalidRandomSeedError } from '../../src/domain/errors/RandomnessErrors'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { generateIndexSample } from '../../tools/hu-26/index-sample-generation'
import { createProductionRandomSequenceFactory } from '../../tools/hu-26/production-factory'
import { generateNormalSample } from '../../tools/hu-26/sample-generation'
import {
  anchorPositions,
  encodeFloat64LittleEndian,
  encodeUint16LittleEndian,
  fingerprintIndexSample,
  fingerprintNormalSample,
  sha256Hex,
} from '../../tools/hu-26/sample-fingerprint'
import { DEFAULT_STUDY_CONFIG_PATH, loadStudyConfig } from '../../tools/hu-26/study-config'

/**
 * Harness del estudio de HU-26 (tooling OFFLINE, fuera del runtime de Combat).
 *
 * Estas pruebas verifican el MECANISMO, no los resultados estadisticos: las
 * muestras salen del codigo productivo (`createNormalSequence`), las semillas
 * candidatas son validas para la implementacion real y la historica invalida se
 * rechaza sin truncarla. El estudio completo (KS, Ljung-Box, Q-Q) se ejecuta
 * aparte (`npm run study:hu-26`) y no forma parte de la CI normal.
 */
const HISTORICAL_INVALID_SEED = 7_294_967_295

const factory = createProductionRandomSequenceFactory()

/** Fabrica de prueba que registra que metodo se invoca y con que semilla. */
const spyingFactory = (): {
  readonly factory: RandomSequenceFactoryPort
  readonly calls: { readonly create: number[]; readonly createNormalSequence: number[] }
} => {
  const calls = { create: [] as number[], createNormalSequence: [] as number[] }

  return {
    calls,
    factory: {
      create: (seed: RandomSeed): RandomSequencePort => {
        calls.create.push(seed.value)

        return { nextIndex: () => RandomIndex.create(4001) }
      },
      createNormalSequence: (seed: RandomSeed): NormalSequencePort => {
        calls.createNormalSequence.push(seed.value)
        let counter = 0

        return {
          nextNormal: () => {
            counter += 1

            return counter / 1000
          },
        }
      },
    },
  }
}

describe('HU-26: diseno del estudio (study-config.json)', () => {
  const config = loadStudyConfig()

  it('conserva el tamano de muestra, alfa y lags del estudio previo como decisiones experimentales', () => {
    expect(config.sampleSize).toBe(100_000)
    expect(config.alpha).toBe(0.05)
    expect(config.ljungBoxLags).toEqual([10, 20, 30, 40, 50])
  })

  it('evalua exactamente 11 candidatas: las 10 historicas validas y RandomSeed.MAX', () => {
    expect(config.candidateSeeds).toEqual([
      0, 1, 42, 53, 234, 365, 777, 1000, 1500, 3_000_000, 4_294_967_295,
    ])
    expect(config.candidateSeeds).toHaveLength(11)
    expect(config.addedBoundaryCandidateSeed).toBe(RandomSeed.MAX)
    expect(config.candidateSeeds).toContain(RandomSeed.MAX)
  })

  it('cada candidata es una RandomSeed valida de la implementacion productiva', () => {
    for (const seed of config.candidateSeeds) {
      expect(RandomSeed.create(seed).value).toBe(seed)
    }
  })

  it('la candidata historica 7.294.967.295 esta documentada como invalida y NO se evalua', () => {
    expect(config.historicalCandidateSeeds).toContain(HISTORICAL_INVALID_SEED)
    expect(config.candidateSeeds).not.toContain(HISTORICAL_INVALID_SEED)
    expect(config.historicalInvalidSeeds).toEqual([
      expect.objectContaining({
        seed: HISTORICAL_INVALID_SEED,
        status: 'CANDIDATA_HISTORICA_INVALIDA_PARA_LA_IMPLEMENTACION_PRODUCTIVA',
      }),
    ])
  })

  it('7.294.967.295 es rechazada por RandomSeed y NO se trunca, ni se aplica modulo ni cast uint32', () => {
    expect(() => RandomSeed.create(HISTORICAL_INVALID_SEED)).toThrow(InvalidRandomSeedError)
    expect(HISTORICAL_INVALID_SEED).toBeGreaterThan(RandomSeed.MAX)
    // Lo que produciria un cast silencioso: OTRA semilla (2.999.999.999) que nadie eligio.
    expect(HISTORICAL_INVALID_SEED % 2 ** 32).toBe(2_999_999_999)
    expect(HISTORICAL_INVALID_SEED >>> 0).toBe(2_999_999_999)
    expect(() => RandomSeed.create(HISTORICAL_INVALID_SEED >>> 0)).not.toThrow()
  })

  it('una configuracion con la semilla invalida como candidata NO carga (fallo, no correccion)', () => {
    const raw = JSON.parse(readFileSync(DEFAULT_STUDY_CONFIG_PATH, 'utf8')) as {
      candidateSeeds: number[]
    }
    raw.candidateSeeds = [0, HISTORICAL_INVALID_SEED]
    const path = join(mkdtempSync(join(tmpdir(), 'hu26-')), 'study-config.json')
    writeFileSync(path, JSON.stringify(raw))

    expect(() => loadStudyConfig(path)).toThrow(InvalidRandomSeedError)
  })

  it('rechaza una configuracion con semillas repetidas o parametros invalidos', () => {
    const load = (change: (raw: Record<string, unknown>) => void): void => {
      const raw = JSON.parse(readFileSync(DEFAULT_STUDY_CONFIG_PATH, 'utf8')) as Record<
        string,
        unknown
      >
      change(raw)
      const path = join(mkdtempSync(join(tmpdir(), 'hu26-')), 'study-config.json')
      writeFileSync(path, JSON.stringify(raw))
      loadStudyConfig(path)
    }

    expect(() => {
      load((raw) => {
        raw.candidateSeeds = [1, 1]
      })
    }).toThrow(/repetidas/)
    expect(() => {
      load((raw) => {
        raw.sampleSize = 0
      })
    }).toThrow(/sampleSize/)
    expect(() => {
      load((raw) => {
        raw.alpha = 1.5
      })
    }).toThrow(/alpha/)
    expect(() => {
      load((raw) => {
        raw.candidateSeeds = 'no-lista'
      })
    }).toThrow(/candidateSeeds/)
    expect(() => {
      load((raw) => {
        raw.historicalInvalidSeeds = 'x'
      })
    }).toThrow(/historicalInvalidSeeds/)
    expect(() => {
      load((raw) => {
        raw.historicalInvalidSeeds = [{ seed: 1 }]
      })
    }).toThrow(/status y reason/)
    expect(() => {
      load((raw) => {
        raw.addedBoundaryCandidate = null
      })
    }).toThrow(/objeto/)
    expect(() => {
      load((raw) => {
        raw.sampleSize = 'muchas'
      })
    }).toThrow(/numero finito/)
  })

  it('la regla de seleccion esta pre-registrada y no favorece ninguna semilla concreta', () => {
    const raw = readFileSync(DEFAULT_STUDY_CONFIG_PATH, 'utf8')

    expect(raw).toContain('PRE-REGISTERED')
    expect(raw).toContain('menor estadistico KS D')
    expect(raw).toContain('NO se elige la')
    // Los pasos de la regla no nombran ninguna semilla concreta como objetivo.
    const rule = JSON.parse(raw).selectionRule as Record<string, unknown>
    const steps = JSON.stringify([rule.step1_filters, rule.step2_ranking, rule.tieBreak])

    expect(steps).not.toMatch(/d{4,}/)
  })
})

describe('HU-26: generacion de la muestra normal con el codigo productivo', () => {
  it('produce exactamente sampleSize valores finitos (RandomSeed.MAX incluida)', () => {
    for (const seed of [0, 42, RandomSeed.MAX]) {
      const sample = generateNormalSample(factory, RandomSeed.create(seed), 5_000)

      expect(sample).toHaveLength(5_000)
      expect(sample.every((value) => Number.isFinite(value))).toBe(true)
    }
  })

  it('usa createNormalSequence y NUNCA create(...).nextIndex()', () => {
    const spy = spyingFactory()

    generateNormalSample(spy.factory, RandomSeed.create(777), 10)

    expect(spy.calls.createNormalSequence).toEqual([777])
    expect(spy.calls.create).toEqual([])
  })

  it('consume nextNormal en orden, una vez por observacion', () => {
    const spy = spyingFactory()

    expect(Array.from(generateNormalSample(spy.factory, RandomSeed.create(1), 4))).toEqual([
      0.001, 0.002, 0.003, 0.004,
    ])
  })

  it('la misma semilla produce la misma muestra y semillas distintas producen muestras distintas', () => {
    const a = generateNormalSample(factory, RandomSeed.create(1), 2_000)
    const b = generateNormalSample(factory, RandomSeed.create(1), 2_000)
    const other = generateNormalSample(factory, RandomSeed.create(42), 2_000)

    expect(Array.from(a)).toEqual(Array.from(b))
    expect(sha256Hex(encodeFloat64LittleEndian(a))).toBe(sha256Hex(encodeFloat64LittleEndian(b)))
    expect(Array.from(a)).not.toEqual(Array.from(other))
    expect(sha256Hex(encodeFloat64LittleEndian(a))).not.toBe(
      sha256Hex(encodeFloat64LittleEndian(other)),
    )
  })

  it('las primeras salidas coinciden con los golden tests de HU-24 (semilla 3.000.000)', () => {
    const sample = generateNormalSample(factory, RandomSeed.create(3_000_000), 6)
    const expected = [
      -0.43720037393349565, -0.1481396670342545, -0.144125791425559, 1.7128865736876675,
      1.161409574171299, 0.08127739813106132,
    ]

    expected.forEach((value, position) => {
      expect(sample[position]).toBeCloseTo(value, 12)
    })
  })

  it('no altera el estado entre semillas: generar otra antes no cambia la muestra de una semilla', () => {
    const alone = generateNormalSample(factory, RandomSeed.create(234), 1_000)

    generateNormalSample(factory, RandomSeed.create(999), 1_000)
    const afterOther = generateNormalSample(factory, RandomSeed.create(234), 1_000)

    expect(Array.from(afterOther)).toEqual(Array.from(alone))
  })
})

describe('HU-26: validacion SECUNDARIA del indice (separada de la normalidad)', () => {
  it('usa create(...).nextIndex() y NUNCA createNormalSequence', () => {
    const spy = spyingFactory()

    generateIndexSample(spy.factory, RandomSeed.create(42), 10)

    expect(spy.calls.create).toEqual([42])
    expect(spy.calls.createNormalSequence).toEqual([])
  })

  it('produce exactamente sampleSize indices enteros en 1..8000 y reproducibles', () => {
    const sample = generateIndexSample(factory, RandomSeed.create(3_000_000), 5_000)

    expect(sample).toHaveLength(5_000)
    expect(sample.every((value) => Number.isInteger(value) && value >= 1 && value <= 8000)).toBe(
      true,
    )
    expect(Array.from(sample.slice(0, 10))).toEqual([
      2648, 3529, 3542, 7654, 7019, 4260, 2553, 5830, 2324, 6027,
    ])
    expect(Array.from(generateIndexSample(factory, RandomSeed.create(3_000_000), 5_000))).toEqual(
      Array.from(sample),
    )
  })
})

describe('HU-26: huellas y codificacion de las muestras', () => {
  it('codifica Float64 y Uint16 little-endian sin cabecera', () => {
    const floats = encodeFloat64LittleEndian(Float64Array.from([1.5, -2.25]))
    const ints = encodeUint16LittleEndian(Uint16Array.from([1, 8000]))

    expect(floats).toHaveLength(16)
    expect(floats.readDoubleLE(0)).toBe(1.5)
    expect(floats.readDoubleLE(8)).toBe(-2.25)
    expect(ints).toHaveLength(4)
    expect(ints.readUInt16LE(0)).toBe(1)
    expect(ints.readUInt16LE(2)).toBe(8000)
  })

  it('sha256Hex es el SHA-256 estandar', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('las anclas son posiciones fijas, sin duplicados y dentro de la muestra', () => {
    expect(anchorPositions(100_000)).toEqual([0, 1, 2, 3, 4, 9_999, 49_999, 99_999])
    expect(anchorPositions(3)).toEqual([0, 1, 2])
    expect(anchorPositions(1)).toEqual([0])
  })

  it('la huella normal resume la muestra y es reproducible', () => {
    const sample = Float64Array.from([1, 2, 3, -4])
    const fingerprint = fingerprintNormalSample(7, sample)

    expect(fingerprint.seed).toBe(7)
    expect(fingerprint.sampleSize).toBe(4)
    expect(fingerprint.sum).toBe(2)
    expect(fingerprint.sumOfSquares).toBe(30)
    expect(fingerprint.anchors.map((anchor) => anchor.value)).toEqual([1, 2, 3, -4])
    expect(fingerprintNormalSample(7, sample)).toEqual(fingerprint)
    expect(fingerprint.sha256).toBe(sha256Hex(encodeFloat64LittleEndian(sample)))
  })

  it('la huella del indice recoge minimo, maximo y SHA-256', () => {
    const sample = Uint16Array.from([4001, 1, 8000, 2500])
    const fingerprint = fingerprintIndexSample(9, sample)

    expect(fingerprint).toEqual({
      seed: 9,
      sampleSize: 4,
      sha256: sha256Hex(encodeUint16LittleEndian(sample)),
      minimum: 1,
      maximum: 8000,
    })
  })
})
