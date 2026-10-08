import { readFile } from 'node:fs/promises'
import { FEATURE_DIMENSION } from '../../application/services/FeatureEncoderV1'
import type { NeuralInferencePort } from '../../application/ports/NeuralInferencePort'

/**
 * Valida la paridad PyTorch <-> ONNX (EN-036.5, Management #569 §86-98)
 * contra el RUNTIME REAL de produccion (`OnnxRuntimeNeuralInferenceAdapter`
 * sobre `onnxruntime-node`), nunca una segunda inferencia inventada.
 * Compara los scores reales del `model.onnx` corrido aqui contra
 * `pytorch-parity-reference.json` (generado por la herramienta Python de
 * `ai/`, sobre el MISMO `model.pt` del MISMO training run) para el MISMO
 * conjunto fijo de feature vectors (los fixtures golden).
 */
export const PARITY_REFERENCE_SCHEMA_VERSION = 'pytorch-onnx-parity-v1'
export const PARITY_ATOL = 1e-5
export const PARITY_RTOL = 1e-5

export interface ParityReferenceCase {
  readonly caseId: string
  readonly candidateFeatures: readonly (readonly number[])[]
  readonly pytorchScores: readonly number[]
}

export interface ParityReference {
  readonly schemaVersion: string
  readonly modelStateSha256: string
  readonly onnxArtifactSha256: string
  readonly featureSchemaVersion: string
  readonly featureDimension: number
  readonly cases: readonly ParityReferenceCase[]
}

export interface ParityReportSummary {
  readonly cases: number
  readonly scoresCompared: number
  readonly maxAbsoluteError: number
  readonly maxRelativeError: number
  readonly meanAbsoluteError: number
  readonly argmaxAgreement: number
  readonly atol: number
  readonly rtol: number
  readonly passed: boolean
}

export class ParityReferenceMismatchError extends Error {
  constructor(reason: string) {
    super(`pytorch-parity-reference.json no corresponde a este modelo: ${reason}`)
    this.name = 'ParityReferenceMismatchError'
  }
}

const argmaxIndex = (scores: readonly number[]): number => {
  let best = 0
  for (let i = 1; i < scores.length; i += 1) {
    const score = scores[i]
    const bestScore = scores[best]
    if (score !== undefined && bestScore !== undefined && score > bestScore) {
      best = i
    }
  }
  return best
}

export const loadParityReference = async (referencePath: string): Promise<ParityReference> => {
  const raw = JSON.parse(await readFile(referencePath, 'utf-8')) as ParityReference

  if (raw.schemaVersion !== PARITY_REFERENCE_SCHEMA_VERSION) {
    throw new ParityReferenceMismatchError(
      `schemaVersion="${raw.schemaVersion}", se esperaba "${PARITY_REFERENCE_SCHEMA_VERSION}".`,
    )
  }
  if (raw.featureDimension !== FEATURE_DIMENSION) {
    throw new ParityReferenceMismatchError(
      `featureDimension=${String(raw.featureDimension)}, se esperaba ${String(FEATURE_DIMENSION)}.`,
    )
  }

  return raw
}

/**
 * `reference` debe venir del MISMO training run que el modelo cargado
 * (#569 §95): se compara `modelStateSha256`/`onnxArtifactSha256` ANTES de
 * correr nada, fail-closed (PA-07: un modelo/referencia manipulado debe
 * fallar, nunca compararse "igual" por casualidad). Solo necesita esos dos
 * hashes, no el manifest completo -- `NeuralModelDescriptor` (#568) ya los
 * expone.
 */
export const assertSameTrainingRun = (
  reference: ParityReference,
  descriptor: { readonly modelStateSha256: string; readonly onnxArtifactSha256: string },
): void => {
  if (reference.modelStateSha256 !== descriptor.modelStateSha256) {
    throw new ParityReferenceMismatchError('modelStateSha256 no coincide con el modelo cargado.')
  }
  if (reference.onnxArtifactSha256 !== descriptor.onnxArtifactSha256) {
    throw new ParityReferenceMismatchError('onnxArtifactSha256 no coincide con el modelo cargado.')
  }
}

/**
 * Corre cada caso de `reference` contra el runtime ONNX y compara con
 * `pytorchScores`. Recibe `NeuralInferencePort` (la abstraccion, no la
 * clase concreta) para poder probarse con un adaptador falso sin el
 * binario nativo (#568 precedente: las pruebas unitarias nunca dependen
 * de `onnxruntime-node` real); en produccion/CLI el llamador pasa un
 * `OnnxRuntimeNeuralInferenceAdapter` real de verdad.
 *
 * `passed` exige TODOS los scores dentro de `atol + rtol * |esperado|`
 * (misma formula que `numpy.allclose`, #569 §92) Y `argmaxAgreement === 1`
 * (#569 §93): un empate de tolerancia que cambia el candidato elegido es
 * una divergencia real, no cosmetica.
 */
export const runParityValidation = async (
  reference: ParityReference,
  inference: NeuralInferencePort,
): Promise<ParityReportSummary> => {
  let maxAbsoluteError = 0
  let maxRelativeError = 0
  let sumAbsoluteError = 0
  let scoresCompared = 0
  let argmaxMatches = 0
  let allWithinTolerance = true

  for (const testCase of reference.cases) {
    const candidateCount = testCase.candidateFeatures.length
    const flat = new Float32Array(candidateCount * FEATURE_DIMENSION)
    testCase.candidateFeatures.forEach((vector, index) => {
      flat.set(Float32Array.from(vector), index * FEATURE_DIMENSION)
    })

    const onnxScores = await inference.score(flat, candidateCount)

    for (let i = 0; i < candidateCount; i += 1) {
      const onnxValue = onnxScores[i]
      const pytorchValue = testCase.pytorchScores[i]
      if (onnxValue === undefined || pytorchValue === undefined) {
        throw new ParityReferenceMismatchError(
          `caso "${testCase.caseId}": longitud de scores inconsistente en el indice ${String(i)}.`,
        )
      }

      const absoluteError = Math.abs(onnxValue - pytorchValue)
      const tolerance = PARITY_ATOL + PARITY_RTOL * Math.abs(pytorchValue)
      if (absoluteError > tolerance) {
        allWithinTolerance = false
      }

      const relativeError =
        Math.abs(pytorchValue) > 0 ? absoluteError / Math.abs(pytorchValue) : absoluteError
      maxAbsoluteError = Math.max(maxAbsoluteError, absoluteError)
      maxRelativeError = Math.max(maxRelativeError, relativeError)
      sumAbsoluteError += absoluteError
      scoresCompared += 1
    }

    if (argmaxIndex(Array.from(onnxScores)) === argmaxIndex(testCase.pytorchScores)) {
      argmaxMatches += 1
    }
  }

  const argmaxAgreement = reference.cases.length > 0 ? argmaxMatches / reference.cases.length : 0

  return {
    cases: reference.cases.length,
    scoresCompared,
    maxAbsoluteError,
    maxRelativeError,
    meanAbsoluteError: scoresCompared > 0 ? sumAbsoluteError / scoresCompared : 0,
    argmaxAgreement,
    atol: PARITY_ATOL,
    rtol: PARITY_RTOL,
    passed: allWithinTolerance && argmaxAgreement === 1,
  }
}
