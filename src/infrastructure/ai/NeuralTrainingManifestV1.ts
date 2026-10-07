import { NeuralModelSchemaMismatchError } from '../../domain/errors/NeuralPolicyErrors'
import {
  FEATURE_DIMENSION,
  FEATURE_SCHEMA_VERSION,
} from '../../application/services/FeatureEncoderV1'

/**
 * Constantes del contrato congelado por EN-036.3 (#567), centralizadas
 * (#568 §125): ningun string disperso en el loader/adapter/policy.
 */
export const NEURAL_MODEL_ARCHITECTURE_VERSION = 'candidate-mlp-v1'
export const NEURAL_TRAINING_MANIFEST_VERSION = 'training-manifest-v1'
export const NEURAL_ONNX_OPSET_VERSION = 18
export const NEURAL_ONNX_INPUT_NAME = 'candidate_features'
export const NEURAL_ONNX_OUTPUT_NAME = 'scores'
export const NEURAL_ONNX_INPUT_DTYPE = 'float32'
export const NEURAL_ONNX_OUTPUT_DTYPE = 'float32'

export const ARTIFACT_PURPOSE_SMOKE_TEST = 'SMOKE_TEST'
export const ARTIFACT_PURPOSE_CANDIDATE = 'CANDIDATE'

export interface NeuralModelContract {
  readonly inputName: string
  readonly inputDtype: string
  readonly inputRank: number
  readonly featureDimension: number
  readonly candidateAxisDynamic: boolean
  readonly outputName: string
  readonly outputDtype: string
  readonly outputRank: number
}

/** Subconjunto de `training-manifest.json` (#567) que #568 realmente consume. */
export interface NeuralTrainingManifestV1 {
  readonly trainingManifestVersion: string
  readonly modelArchitectureVersion: string
  readonly featureSchemaVersion: string
  readonly featureDimension: number
  readonly onnxOpsetVersion: number
  readonly onnxArtifactSha256: string
  readonly modelStateSha256: string
  readonly artifactPurpose: string
  readonly modelContract: NeuralModelContract
}

/** Metadata minima para logs/observabilidad (#568 §51), sin persistencia nueva. */
export interface NeuralModelDescriptor {
  readonly modelArchitectureVersion: string
  readonly featureSchemaVersion: string
  readonly modelStateSha256: string
  readonly onnxArtifactSha256: string
  readonly artifactPurpose: string
}

export const toNeuralModelDescriptor = (
  manifest: NeuralTrainingManifestV1,
): NeuralModelDescriptor => ({
  modelArchitectureVersion: manifest.modelArchitectureVersion,
  featureSchemaVersion: manifest.featureSchemaVersion,
  modelStateSha256: manifest.modelStateSha256,
  onnxArtifactSha256: manifest.onnxArtifactSha256,
  artifactPurpose: manifest.artifactPurpose,
})

const fail = (reason: string): never => {
  throw new NeuralModelSchemaMismatchError(reason)
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value === '') fail(`"${field}" debe ser texto no vacio.`)
  return value as string
}

const requireNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`"${field}" debe ser numerico.`)
  return value as number
}

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') fail(`"${field}" debe ser booleano.`)
  return value as boolean
}

const requireExact = <T>(actual: T, expected: T, field: string): void => {
  if (actual !== expected) {
    fail(`"${field}" = ${JSON.stringify(actual)}, se esperaba ${JSON.stringify(expected)}.`)
  }
}

/**
 * Parsea Y valida en un solo paso (#568 §121-122: sin zod, sin una libreria
 * nueva solo para un JSON fijo; sin separar "parse" de "validate" cuando
 * ambos pasos exigen lo mismo: NO aceptar un manifest "parecido" -- cada
 * campo del contrato congelado por #567 se compara por EXACTA igualdad
 * (#568 §41, §90). Lanza `NeuralModelSchemaMismatchError` ante la primera
 * discrepancia; el caller (`NeuralModelArtifactLoader`) la convierte en
 * "modelo no disponible", nunca en una caida del servicio.
 */
export const parseAndValidateTrainingManifest = (raw: unknown): NeuralTrainingManifestV1 => {
  if (raw === null || typeof raw !== 'object') {
    return fail('training-manifest.json no es un objeto JSON.')
  }
  const obj = raw as Record<string, unknown>

  const trainingManifestVersion = requireString(
    obj.trainingManifestVersion,
    'trainingManifestVersion',
  )
  requireExact(trainingManifestVersion, NEURAL_TRAINING_MANIFEST_VERSION, 'trainingManifestVersion')

  const modelArchitectureVersion = requireString(
    obj.modelArchitectureVersion,
    'modelArchitectureVersion',
  )
  requireExact(
    modelArchitectureVersion,
    NEURAL_MODEL_ARCHITECTURE_VERSION,
    'modelArchitectureVersion',
  )

  const featureSchemaVersion = requireString(obj.featureSchemaVersion, 'featureSchemaVersion')
  requireExact(featureSchemaVersion, FEATURE_SCHEMA_VERSION, 'featureSchemaVersion')

  const featureDimension = requireNumber(obj.featureDimension, 'featureDimension')
  requireExact(featureDimension, FEATURE_DIMENSION, 'featureDimension')

  const onnxOpsetVersion = requireNumber(obj.onnxOpsetVersion, 'onnxOpsetVersion')
  requireExact(onnxOpsetVersion, NEURAL_ONNX_OPSET_VERSION, 'onnxOpsetVersion')

  const onnxArtifactSha256 = requireString(obj.onnxArtifactSha256, 'onnxArtifactSha256')
  const modelStateSha256 = requireString(obj.modelStateSha256, 'modelStateSha256')
  const artifactPurpose = requireString(obj.artifactPurpose, 'artifactPurpose')
  if (
    artifactPurpose !== ARTIFACT_PURPOSE_SMOKE_TEST &&
    artifactPurpose !== ARTIFACT_PURPOSE_CANDIDATE
  ) {
    fail(`"artifactPurpose" = "${artifactPurpose}" no es un valor reconocido.`)
  }

  const contractRaw = obj.modelContract
  if (contractRaw === null || typeof contractRaw !== 'object') {
    return fail('"modelContract" no es un objeto JSON.')
  }
  const contractObj = contractRaw as Record<string, unknown>

  const inputName = requireString(contractObj.inputName, 'modelContract.inputName')
  requireExact(inputName, NEURAL_ONNX_INPUT_NAME, 'modelContract.inputName')
  const inputDtype = requireString(contractObj.inputDtype, 'modelContract.inputDtype')
  requireExact(inputDtype, NEURAL_ONNX_INPUT_DTYPE, 'modelContract.inputDtype')
  const inputRank = requireNumber(contractObj.inputRank, 'modelContract.inputRank')
  requireExact(inputRank, 2, 'modelContract.inputRank')
  const contractFeatureDimension = requireNumber(
    contractObj.featureDimension,
    'modelContract.featureDimension',
  )
  requireExact(contractFeatureDimension, FEATURE_DIMENSION, 'modelContract.featureDimension')
  const candidateAxisDynamic = requireBoolean(
    contractObj.candidateAxisDynamic,
    'modelContract.candidateAxisDynamic',
  )
  requireExact(candidateAxisDynamic, true, 'modelContract.candidateAxisDynamic')
  const outputName = requireString(contractObj.outputName, 'modelContract.outputName')
  requireExact(outputName, NEURAL_ONNX_OUTPUT_NAME, 'modelContract.outputName')
  const outputDtype = requireString(contractObj.outputDtype, 'modelContract.outputDtype')
  requireExact(outputDtype, NEURAL_ONNX_OUTPUT_DTYPE, 'modelContract.outputDtype')
  const outputRank = requireNumber(contractObj.outputRank, 'modelContract.outputRank')
  requireExact(outputRank, 1, 'modelContract.outputRank')

  return {
    trainingManifestVersion,
    modelArchitectureVersion,
    featureSchemaVersion,
    featureDimension,
    onnxOpsetVersion,
    onnxArtifactSha256,
    modelStateSha256,
    artifactPurpose,
    modelContract: {
      inputName,
      inputDtype,
      inputRank,
      featureDimension: contractFeatureDimension,
      candidateAxisDynamic,
      outputName,
      outputDtype,
      outputRank,
    },
  }
}
