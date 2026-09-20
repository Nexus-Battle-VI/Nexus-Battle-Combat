import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

/**
 * Diseno PRE-REGISTRADO del estudio de HU-26 (`study-config.json`).
 *
 * Es solo tooling offline: vive fuera de `src/` para no entrar en la imagen de
 * Combat ni en el hot path. Todo lo que define (semillas, tamano de muestra,
 * alfa, lags, regla de seleccion) es una DECISION EXPERIMENTAL del estudio, no
 * un requisito funcional de RF-26.
 */
export interface HistoricalInvalidSeed {
  readonly seed: number
  readonly status: string
  readonly reason: string
}

export interface StudyConfig {
  readonly sampleSize: number
  readonly alpha: number
  readonly ljungBoxLags: readonly number[]
  /** Semillas VALIDAS para la implementacion productiva, en el orden del estudio. */
  readonly candidateSeeds: readonly number[]
  readonly historicalCandidateSeeds: readonly number[]
  readonly historicalInvalidSeeds: readonly HistoricalInvalidSeed[]
  readonly addedBoundaryCandidateSeed: number
  readonly indexUniformityBins: number
}

export const DEFAULT_STUDY_CONFIG_PATH = resolve('tools', 'hu-26', 'study-config.json')

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`study-config: "${label}" debe ser un objeto.`)
  }

  return value as Record<string, unknown>
}

const asNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`study-config: "${label}" debe ser un numero finito.`)
  }

  return value
}

const asNumberList = (value: unknown, label: string): readonly number[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`study-config: "${label}" debe ser una lista no vacia.`)
  }

  return value.map((item, position) => asNumber(item, `${label}[${String(position)}]`))
}

/**
 * Lee y valida el diseno. Cada candidata debe ser una `RandomSeed` VALIDA de la
 * implementacion productiva (uint32): una semilla invalida NO se trunca ni se
 * corrige, hace fallar la carga. Las candidatas historicas invalidas se listan
 * aparte, a proposito, y se comprueba que sigan siendo rechazadas.
 */
export const loadStudyConfig = (path: string = DEFAULT_STUDY_CONFIG_PATH): StudyConfig => {
  const root = asRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown, 'raiz')

  const sampleSize = asNumber(root.sampleSize, 'sampleSize')
  const alpha = asNumber(root.alpha, 'alpha')

  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    throw new Error('study-config: "sampleSize" debe ser un entero positivo.')
  }

  if (alpha <= 0 || alpha >= 1) {
    throw new Error('study-config: "alpha" debe estar en (0, 1).')
  }

  const candidateSeeds = asNumberList(root.candidateSeeds, 'candidateSeeds')

  for (const seed of candidateSeeds) {
    RandomSeed.create(seed)
  }

  if (new Set(candidateSeeds).size !== candidateSeeds.length) {
    throw new Error('study-config: "candidateSeeds" contiene semillas repetidas.')
  }

  const invalidRaw = root.historicalInvalidSeeds

  if (!Array.isArray(invalidRaw)) {
    throw new Error('study-config: "historicalInvalidSeeds" debe ser una lista.')
  }

  const historicalInvalidSeeds = (invalidRaw as unknown[]).map((entry, position) => {
    const record = asRecord(entry, `historicalInvalidSeeds[${String(position)}]`)
    const seed = asNumber(record.seed, 'historicalInvalidSeeds.seed')

    if (typeof record.status !== 'string' || typeof record.reason !== 'string') {
      throw new Error('study-config: cada semilla historica invalida necesita status y reason.')
    }

    return { seed, status: record.status, reason: record.reason }
  })

  const boundary = asRecord(root.addedBoundaryCandidate, 'addedBoundaryCandidate')
  const secondary = asRecord(root.secondaryChecks, 'secondaryChecks')
  const uniformity = asRecord(secondary.indexUniformity, 'secondaryChecks.indexUniformity')

  return {
    sampleSize,
    alpha,
    ljungBoxLags: asNumberList(root.ljungBoxLags, 'ljungBoxLags'),
    candidateSeeds,
    historicalCandidateSeeds: asNumberList(
      root.historicalCandidateSeeds,
      'historicalCandidateSeeds',
    ),
    historicalInvalidSeeds,
    addedBoundaryCandidateSeed: asNumber(boundary.seed, 'addedBoundaryCandidate.seed'),
    indexUniformityBins: asNumber(uniformity.bins, 'secondaryChecks.indexUniformity.bins'),
  }
}
