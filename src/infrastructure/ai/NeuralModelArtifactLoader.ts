import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { FeatureEncoderV1 } from '../../application/services/FeatureEncoderV1'
import { NeuralPolicy } from '../../application/policies/NeuralPolicy'
import type { DecisionPolicyBinding } from '../../application/services/DecisionPolicySelector'
import type { AppConfig } from '../config/env'
import type { Logger } from '../observability/logger'
import {
  NeuralModelArtifactError,
  NeuralModelHashMismatchError,
} from '../../domain/errors/NeuralPolicyErrors'
import { describeError } from '../observability/describe-error'
import {
  ARTIFACT_PURPOSE_SMOKE_TEST,
  type NeuralModelDescriptor,
  type NeuralTrainingManifestV1,
  parseAndValidateTrainingManifest,
  toNeuralModelDescriptor,
} from './NeuralTrainingManifestV1'
import { OnnxRuntimeNeuralInferenceAdapter } from './OnnxRuntimeNeuralInferenceAdapter'

export type NeuralPrimaryBinding = DecisionPolicyBinding & { readonly source: 'NEURAL' }

export interface NeuralArtifactLoadOptions {
  readonly onnxPath: string
  readonly manifestPath: string
  readonly nodeEnv: string
  readonly allowSmokeModel: boolean
  readonly inferenceTimeoutMs: number
}

export interface ValidatedNeuralArtifact {
  readonly policy: NeuralPolicy
  readonly descriptor: NeuralModelDescriptor
  readonly manifest: NeuralTrainingManifestV1
}

const requireRegularFile = async (path: string, label: string): Promise<void> => {
  // #568 §101: solo abre paths de configuracion del operador, nunca de un
  // request; confirma que es un archivo regular legible antes de leerlo
  // (nunca lo escribe).
  let stats
  try {
    stats = await stat(path)
  } catch (error) {
    throw new NeuralModelArtifactError(
      `${label} ("${path}") no se pudo leer: ${describeError(error)}`,
    )
  }
  if (!stats.isFile()) {
    throw new NeuralModelArtifactError(`${label} ("${path}") no es un archivo regular.`)
  }
}

/**
 * Cadena de validacion (defense in depth, #568 §41-45, §89-92), extraida
 * (EN-036.5, Management #569 §157-160) para que produccion (abajo) Y el
 * harness de evaluacion offline (`src/evaluation/`) sean el MISMO y UNICO
 * punto de autoridad del contrato -- nunca dos parsers/validadores
 * distintos del mismo `training-manifest.json` (#569 §159).
 *
 * Orden: manifest JSON -> contrato congelado por #567 (versiones/dimension/
 * modelContract exactos) -> `artifactPurpose` (SMOKE_TEST nunca con
 * `nodeEnv==='production'`, sin excepcion ni con `allowSmokeModel`) ->
 * SHA-256 real de `model.onnx` contra `onnxArtifactSha256` ->
 * `InferenceSession.create()` + smoke real `[1,72]` (dentro de
 * `OnnxRuntimeNeuralInferenceAdapter.create`). Nunca propaga a `null`: a
 * diferencia de `loadNeuralPrimaryPolicy`, ESTA funcion SI lanza (#569
 * §169: si un matchup requiere Neural y el artefacto no carga, el harness
 * debe fallar antes de arrancar combates, nunca saltarlo en silencio).
 */
export const loadValidatedNeuralArtifact = async (
  options: NeuralArtifactLoadOptions,
): Promise<ValidatedNeuralArtifact> => {
  await requireRegularFile(options.manifestPath, 'manifestPath')
  await requireRegularFile(options.onnxPath, 'onnxPath')

  const manifestRaw = await readFile(options.manifestPath, 'utf-8')
  const manifest = parseAndValidateTrainingManifest(JSON.parse(manifestRaw) as unknown)

  if (manifest.artifactPurpose === ARTIFACT_PURPOSE_SMOKE_TEST) {
    if (options.nodeEnv === 'production') {
      throw new NeuralModelArtifactError(
        'artifactPurpose=SMOKE_TEST nunca se activa con nodeEnv=production.',
      )
    }
    if (!options.allowSmokeModel) {
      throw new NeuralModelArtifactError(
        'artifactPurpose=SMOKE_TEST requiere allowSmokeModel=true explicito fuera de produccion.',
      )
    }
  }

  const onnxBytes = await readFile(options.onnxPath)
  const actualHash = createHash('sha256').update(onnxBytes).digest('hex')
  if (actualHash !== manifest.onnxArtifactSha256) {
    throw new NeuralModelHashMismatchError()
  }

  const adapter = await OnnxRuntimeNeuralInferenceAdapter.create(options.onnxPath)
  const policy = new NeuralPolicy(new FeatureEncoderV1(), adapter, options.inferenceTimeoutMs)
  const descriptor = toNeuralModelDescriptor(manifest)

  return { policy, descriptor, manifest }
}

/**
 * Carga, valida y activa `NeuralPolicy` como primaria UNA sola vez durante
 * el bootstrap (EN-036.4, Management #568 §40-48, §71, §79-80). Fail-closed
 * en el sentido de "nunca activa un modelo invalido", pero fail-OPEN para
 * la disponibilidad del servicio (#568 §45): CUALQUIER fallo de
 * `loadValidatedNeuralArtifact` devuelve `null` (log
 * `neural_model_unavailable`) en vez de propagar -- Combat arranca igual,
 * `RuleBasedPolicy` sigue siendo el fallback fijo.
 */
export const loadNeuralPrimaryPolicy = async (
  config: AppConfig,
  logger: Logger,
): Promise<NeuralPrimaryBinding | null> => {
  if (!config.neuralPolicyEnabled) {
    return null
  }

  try {
    if (config.neuralModelOnnxPath === null || config.neuralModelManifestPath === null) {
      throw new NeuralModelArtifactError(
        'NEURAL_POLICY_ENABLED=true requiere NEURAL_MODEL_ONNX_PATH y NEURAL_MODEL_MANIFEST_PATH.',
      )
    }

    const { policy, descriptor } = await loadValidatedNeuralArtifact({
      onnxPath: config.neuralModelOnnxPath,
      manifestPath: config.neuralModelManifestPath,
      nodeEnv: config.nodeEnv,
      allowSmokeModel: config.neuralAllowSmokeModel,
      inferenceTimeoutMs: config.neuralInferenceTimeoutMs,
    })

    logger.info('neural_model_loaded', {
      modelArchitectureVersion: descriptor.modelArchitectureVersion,
      featureSchemaVersion: descriptor.featureSchemaVersion,
      modelStateSha256Prefix: descriptor.modelStateSha256.slice(0, 12),
      artifactPurpose: descriptor.artifactPurpose,
    })

    return { policy, source: 'NEURAL' as const }
  } catch (error: unknown) {
    logger.error('neural_model_unavailable', {
      reason: error instanceof Error ? error.name : 'unknown',
      detail: describeError(error),
    })
    return null
  }
}
