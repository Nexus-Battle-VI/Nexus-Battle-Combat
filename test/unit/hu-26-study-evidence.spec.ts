import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { generateIndexSample } from '../../tools/hu-26/index-sample-generation'
import { createProductionRandomSequenceFactory } from '../../tools/hu-26/production-factory'
import { generateNormalSample } from '../../tools/hu-26/sample-generation'
import {
  fingerprintIndexSample,
  fingerprintNormalSample,
  type IndexSampleFingerprint,
  type NormalSampleFingerprint,
} from '../../tools/hu-26/sample-fingerprint'
import { loadStudyConfig } from '../../tools/hu-26/study-config'

/**
 * Vigilancia de la EVIDENCIA de HU-26 committeada en `docs/evidence/hu-26/`.
 *
 * No repite el estudio estadistico (KS, Ljung-Box y Q-Q se ejecutan con
 * `npm run study:hu-26`, fuera de la CI normal). Comprueba dos cosas:
 *
 *  1. DERIVA DEL GENERADOR: regenera las 11 muestras con el codigo productivo y
 *     las contrasta con las huellas del estudio. Si alguien cambia MT19937,
 *     Box-Muller, la CDF o el mapper, la evidencia deja de corresponder al codigo
 *     y esta prueba falla.
 *  2. COHERENCIA DE LA DECISION: recalcula, de forma independiente al script de
 *     Python, la regla pre-registrada sobre el CSV y comprueba que la semilla
 *     seleccionada es la que esa regla produce.
 */
const EVIDENCE = join(__dirname, '..', '..', 'docs', 'evidence', 'hu-26')
const config = loadStudyConfig()

interface Fingerprints {
  readonly sampleSize: number
  readonly normal: readonly NormalSampleFingerprint[]
  readonly index: readonly IndexSampleFingerprint[]
}

const readFingerprints = (): Fingerprints =>
  JSON.parse(readFileSync(join(EVIDENCE, 'sample-fingerprints.json'), 'utf8')) as Fingerprints

const readCsv = (file: string): Record<string, string>[] => {
  const [header, ...lines] = readFileSync(join(EVIDENCE, file), 'utf8').trim().split('\n')
  const columns = (header ?? '').split(',')

  return lines.map((line) => {
    const cells = line.split(',')

    return Object.fromEntries(columns.map((column, position) => [column, cells[position] ?? '']))
  })
}

describe('HU-26: la evidencia existe y corresponde al diseno pre-registrado', () => {
  it('estan todos los artefactos generados', () => {
    for (const file of [
      'sample-fingerprints.json',
      'seed-comparison.csv',
      'seed-comparison.md',
      'selected-seed.json',
      'index-uniformity.csv',
      'analysis-self-check.json',
    ]) {
      expect(existsSync(join(EVIDENCE, file))).toBe(true)
    }
  })

  it('hay un Q-Q por candidata y ninguno de la semilla historica invalida', () => {
    for (const seed of config.candidateSeeds) {
      expect(existsSync(join(EVIDENCE, 'qq', `seed-${String(seed)}.png`))).toBe(true)
    }

    expect(existsSync(join(EVIDENCE, 'qq', 'seed-7294967295.png'))).toBe(false)
  })

  it('las huellas cubren exactamente las 11 candidatas validas y N = sampleSize', () => {
    const fingerprints = readFingerprints()

    expect(fingerprints.sampleSize).toBe(config.sampleSize)
    expect(fingerprints.normal.map((entry) => entry.seed)).toEqual([...config.candidateSeeds])
    expect(fingerprints.index.map((entry) => entry.seed)).toEqual([...config.candidateSeeds])
    expect(JSON.stringify(fingerprints)).not.toContain('7294967295')
  })
})

describe('HU-26: deriva del generador (regenera las muestras con el codigo productivo)', () => {
  const fingerprints = readFingerprints()
  const factory = createProductionRandomSequenceFactory()

  it.each(config.candidateSeeds)(
    'semilla %i: la muestra normal regenerada coincide con la huella del estudio',
    (rawSeed) => {
      const expected = fingerprints.normal.find((entry) => entry.seed === rawSeed)
      const sample = generateNormalSample(factory, RandomSeed.create(rawSeed), config.sampleSize)
      const actual = fingerprintNormalSample(rawSeed, sample)

      expect(expected).toBeDefined()
      expect(actual.sampleSize).toBe(expected?.sampleSize)

      // Tolerancia en lugar de SHA-256 estricto: la huella exacta se verifica al
      // ejecutar el estudio (analyze.py) en la misma plataforma; en CI se admiten
      // diferencias de 1 ULP de la libm y se detecta cualquier cambio algoritmico.
      expect(Math.abs(actual.sum - (expected?.sum ?? Number.NaN))).toBeLessThan(1e-6)
      expect(Math.abs(actual.sumOfSquares - (expected?.sumOfSquares ?? Number.NaN))).toBeLessThan(
        1e-6,
      )
      actual.anchors.forEach((anchor, position) => {
        expect(anchor.position).toBe(expected?.anchors[position]?.position)
        expect(anchor.value).toBeCloseTo(expected?.anchors[position]?.value ?? Number.NaN, 12)
      })
    },
  )

  it.each(config.candidateSeeds)(
    'semilla %i: la muestra de indices regenerada coincide byte a byte (SHA-256) con la del estudio',
    (rawSeed) => {
      const expected = fingerprints.index.find((entry) => entry.seed === rawSeed)
      const sample = generateIndexSample(factory, RandomSeed.create(rawSeed), config.sampleSize)

      // Los indices son enteros: no dependen de diferencias de 1 ULP.
      expect(fingerprintIndexSample(rawSeed, sample)).toEqual(expected)
    },
  )
})

describe('HU-26: la semilla seleccionada es la que produce la regla pre-registrada', () => {
  const rows = readCsv('seed-comparison.csv')
  const selected = JSON.parse(readFileSync(join(EVIDENCE, 'selected-seed.json'), 'utf8')) as {
    status: string
    seed: number | null
    sampleSize: number
    alpha: number
    acceptedSeedsRankedByKsD: number[]
    candidateSeeds: number[]
  }

  it('hay una fila por candidata y N coincide con el diseno', () => {
    expect(rows.map((row) => Number(row.seed))).toEqual([...config.candidateSeeds])
    expect(rows.every((row) => Number(row.n) === config.sampleSize)).toBe(true)
    expect(selected.sampleSize).toBe(config.sampleSize)
    expect(selected.alpha).toBe(config.alpha)
    expect(selected.candidateSeeds).toEqual([...config.candidateSeeds])
  })

  it('los filtros KS y Ljung-Box de cada fila son coherentes con alfa', () => {
    for (const row of rows) {
      const lbP = config.ljungBoxLags.map((lag) => Number(row[`lb_p_${String(lag)}`]))

      expect(Number(row.lb_min_p)).toBe(Math.min(...lbP))
      expect(row.ks_ok === 'true').toBe(Number(row.ks_p) > config.alpha)
      expect(row.lb_ok === 'true').toBe(Number(row.lb_min_p) > config.alpha)
      expect(row.accepted === 'true').toBe(row.ks_ok === 'true' && row.lb_ok === 'true')
    }
  })

  it('recalculando la regla (menor KS D entre las aceptadas) sale la misma semilla', () => {
    const accepted = rows
      .filter((row) => row.ks_ok === 'true' && row.lb_ok === 'true')
      .map((row) => ({ seed: Number(row.seed), d: Number(row.ks_d) }))
      .sort((a, b) => a.d - b.d || a.seed - b.seed)

    if (accepted.length === 0) {
      expect(selected.status).toBe('NO_ACCEPTED_CANDIDATE')
      expect(selected.seed).toBeNull()
    } else {
      expect(selected.status).toBe('SELECTED')
      expect(selected.seed).toBe(accepted[0]?.seed)
      expect(selected.acceptedSeedsRankedByKsD).toEqual(accepted.map((entry) => entry.seed))
      expect(rows.filter((row) => row.selected === 'true').map((row) => Number(row.seed))).toEqual([
        selected.seed,
      ])
    }
  })

  it('la validacion secundaria del indice mantiene 1..8000 y NO participa en la seleccion', () => {
    const indexRows = readCsv('index-uniformity.csv')

    expect(indexRows).toHaveLength(config.candidateSeeds.length)
    expect(indexRows.every((row) => row.in_range_1_8000 === 'true')).toBe(true)
    // El CSV de seleccion no contiene columnas del indice.
    expect(Object.keys(rows[0] ?? {})).not.toContain('chi2')
  })
})
