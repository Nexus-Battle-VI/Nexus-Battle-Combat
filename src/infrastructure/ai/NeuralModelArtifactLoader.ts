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
  parseAndValidateTrainingManifest,
  toNeuralModelDescriptor,
} from './NeuralTrainingManifestV1'
import { OnnxRuntimeNeuralInferenceAdapter } from './OnnxRuntimeNeuralInferenceAdapter'

export type NeuralPrimaryBinding = DecisionPolicyBinding & { readonly source: 'NEURAL' }

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
 * Carga, valida y activa `NeuralPolicy` como primaria UNA sola vez durante
 * el bootstrap (EN-036.4, Management #568 §40-48, §71, §79-80). Fail-closed
 * en el sentido de "nunca activa un modelo invalido", pero fail-OPEN para
 * la disponibilidad del servicio (#568 §45): CUALQUIER fallo de aqui
 * devuelve `null` (log `neural_model_unavailable`) en vez de propagar --
 * Combat arranca igual, `RuleBasedPolicy` sigue siendo el fallback fijo.
 *
 * Orden de validacion (defense in depth, #568 §41-45, §89-92): manifest
 * JSON -> contrato congelado por #567 (versiones/dimension/modelContract
 * exactos) -> `artifactPurpose` (SMOKE_TEST nunca en produccion, #568 §73,
 * sin excepcion ni con `NEURAL_ALLOW_SMOKE_MODEL=true`) -> SHA-256 real de
 * `model.onnx` contra `onnxArtifactSha256` -> `InferenceSession.create()` +
 * smoke real `[1,72]` (dentro de `OnnxRuntimeNeuralInferenceAdapter.create`).
 * Nunca se le da a ONNX Runtime la primera linea de defensa (#568 §91).
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

    await requireRegularFile(config.neuralModelManifestPath, 'NEURAL_MODEL_MANIFEST_PATH')
    await requireRegularFile(config.neuralModelOnnxPath, 'NEURAL_MODEL_ONNX_PATH')

    const manifestRaw = await readFile(config.neuralModelManifestPath, 'utf-8')
    const manifest = parseAndValidateTrainingManifest(JSON.parse(manifestRaw) as unknown)

    if (manifest.artifactPurpose === ARTIFACT_PURPOSE_SMOKE_TEST) {
      if (config.nodeEnv === 'production') {
        throw new NeuralModelArtifactError(
          'artifactPurpose=SMOKE_TEST nunca se activa con NODE_ENV=production.',
        )
      }
      if (!config.neuralAllowSmokeModel) {
        throw new NeuralModelArtifactError(
          'artifactPurpose=SMOKE_TEST requiere NEURAL_ALLOW_SMOKE_MODEL=true explicito fuera de ' +
            'produccion.',
        )
      }
    }

    const onnxBytes = await readFile(config.neuralModelOnnxPath)
    const actualHash = createHash('sha256').update(onnxBytes).digest('hex')
    if (actualHash !== manifest.onnxArtifactSha256) {
      throw new NeuralModelHashMismatchError()
    }

    const adapter = await OnnxRuntimeNeuralInferenceAdapter.create(config.neuralModelOnnxPath)
    const policy = new NeuralPolicy(
      new FeatureEncoderV1(),
      adapter,
      config.neuralInferenceTimeoutMs,
    )

    const descriptor = toNeuralModelDescriptor(manifest)
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
