import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AiModelArtifactRepositoryPort } from '../../application/ports/AiModelArtifactRepositoryPort'
import type { AiModelVersion } from '../../domain/entities/AiModelVersion'
import { ModelArtifactNotFoundError } from '../../domain/errors/AiModelRegistryErrors'
import { FEATURE_DIMENSION } from '../../application/services/FeatureEncoderV1'
import {
  NEURAL_MODEL_ARCHITECTURE_VERSION,
  NEURAL_ONNX_INPUT_DTYPE,
  NEURAL_ONNX_INPUT_NAME,
  NEURAL_ONNX_OPSET_VERSION,
  NEURAL_ONNX_OUTPUT_DTYPE,
  NEURAL_ONNX_OUTPUT_NAME,
  NEURAL_TRAINING_MANIFEST_VERSION,
  type NeuralModelContract,
} from '../ai/NeuralTrainingManifestV1'

/**
 * Reconstruye el directorio `{model.onnx, training-manifest.json,
 * pytorch-parity-reference.json}` que el harness de evaluacion (#569,
 * `NeuralEvaluationPolicy.load`/`loadValidatedNeuralArtifact`) necesita,
 * a partir de una `AiModelVersion` YA registrada y su artifact store
 * (EN-037.3, Management #572 §6, §11.2).
 *
 * El `training-manifest.json` original NUNCA se persiste completo en
 * Mongo (#570 §9: solo sus hashes/campos extraidos en `artifactLineage`)
 * -- pero el LOADER de #568 (`loadValidatedNeuralArtifact`) solo valida
 * `onnxArtifactSha256 contra los bytes REALES del ONNX, nunca la
 * procedencia byte a byte del manifest. Los campos que el loader SI
 * consume (`NeuralTrainingManifestV1`) son, o bien datos ya presentes en
 * el registry (`modelArchitectureVersion`, `featureSchemaVersion`,
 * `onnxArtifactSha256`, `modelStateSha256`, `artifactPurpose`), o bien
 * CONSTANTES congeladas e identicas para cada modelo de esta arquitectura
 * (`featureDimension`, `onnxOpsetVersion`, `modelContract` -- ver
 * `test/fixtures/ai-model-registry/training-manifest.json`, los mismos
 * valores fijos que `NeuralTrainingManifestV1.ts` ya exige con
 * `requireExact`). Por eso reconstruir el manifest aqui es equivalente,
 * nunca una aproximacion: el loader no distingue un manifest
 * reconstruido de uno originalmente escrito por `nexus-combat-train`.
 */
const FROZEN_NEURAL_MODEL_CONTRACT: NeuralModelContract = {
  inputName: NEURAL_ONNX_INPUT_NAME,
  inputDtype: NEURAL_ONNX_INPUT_DTYPE,
  inputRank: 2,
  featureDimension: FEATURE_DIMENSION,
  candidateAxisDynamic: true,
  outputName: NEURAL_ONNX_OUTPUT_NAME,
  outputDtype: NEURAL_ONNX_OUTPUT_DTYPE,
  outputRank: 1,
}

export interface MaterializedNeuralArtifactPaths {
  readonly dir: string
  readonly onnxPath: string
  readonly manifestPath: string
  readonly parityReferencePath: string | null
}

export interface MaterializeNeuralArtifactOptions {
  /** Evaluacion=true; runtime=false porque inferencia no consume la referencia PyTorch. */
  readonly includeParityReference: boolean
}

const requireArtifactBytes = async (
  artifactRepository: AiModelArtifactRepositoryPort,
  sha256: string,
): Promise<Buffer> => {
  const artifact = await artifactRepository.getBySha256(sha256)
  if (artifact === null) throw new ModelArtifactNotFoundError(sha256)
  return artifact.bytes
}

/**
 * Materializa UNA version (candidato o ACTIVE baseline) en `dir`.
 * `version.artifactLineage` DEBE existir (siempre cierto para
 * `CANDIDATE`/`EVALUATING`/`ACTIVE`/`SUPERSEDED`, nunca para `TRAINING`
 * o `REJECTED` temprano -- ver invariantes de `AiModelVersion`).
 */
export const materializeNeuralArtifactDir = async (
  artifactRepository: AiModelArtifactRepositoryPort,
  version: AiModelVersion,
  dir: string,
  options: MaterializeNeuralArtifactOptions = { includeParityReference: true },
): Promise<MaterializedNeuralArtifactPaths> => {
  const lineage = version.artifactLineage
  if (lineage === null) {
    throw new Error(
      `No se puede materializar "${version.modelVersion}": no tiene artifactLineage (estado="${version.state}").`,
    )
  }

  await mkdir(dir, { recursive: true })

  const onnxBytes = await requireArtifactBytes(artifactRepository, lineage.onnxArtifactSha256)
  const parityReferenceBytes =
    options.includeParityReference && lineage.parityReferenceSha256 !== null
      ? await requireArtifactBytes(artifactRepository, lineage.parityReferenceSha256)
      : null
  if (options.includeParityReference && parityReferenceBytes === null) {
    throw new Error(
      `No se puede evaluar "${version.modelVersion}": no conserva parityReferenceSha256.`,
    )
  }

  const onnxPath = join(dir, 'model.onnx')
  const manifestPath = join(dir, 'training-manifest.json')
  const parityReferencePath =
    parityReferenceBytes === null ? null : join(dir, 'pytorch-parity-reference.json')

  await writeFile(onnxPath, onnxBytes)
  if (parityReferencePath !== null && parityReferenceBytes !== null) {
    await writeFile(parityReferencePath, parityReferenceBytes)
  }
  await writeFile(
    manifestPath,
    JSON.stringify({
      trainingManifestVersion: NEURAL_TRAINING_MANIFEST_VERSION,
      modelArchitectureVersion: NEURAL_MODEL_ARCHITECTURE_VERSION,
      featureSchemaVersion: version.trainingLineage.featureSchemaVersion,
      featureDimension: FEATURE_DIMENSION,
      onnxOpsetVersion: NEURAL_ONNX_OPSET_VERSION,
      onnxArtifactSha256: lineage.onnxArtifactSha256,
      modelStateSha256: lineage.modelStateSha256,
      artifactPurpose: lineage.artifactPurpose,
      modelContract: FROZEN_NEURAL_MODEL_CONTRACT,
    }),
    'utf-8',
  )

  return { dir, onnxPath, manifestPath, parityReferencePath }
}
