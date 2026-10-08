import { fail, requireNumber, requireString } from './NeuralTrainingManifestV1'

/**
 * `dataset-manifest-v1` (EN-036.2, Management #566; consumido por el
 * worker de reentrenamiento continuo EN-037.2, #571 §7): el manifest que
 * escribe `nexus-combat-dataset build` en `<output>/manifest.json`
 * (`ai/src/nexus_combat_ai/dataset/manifest.py::build_manifest`). El
 * worker lo lee para decidir si el dataset es entrenable ANTES de invocar
 * `nexus-combat-train`, y para construir el `AiModelTrainingLineage` sin
 * reinterpretar campos que Python ya calculo.
 *
 * Todos los campos aqui son EXACTAMENTE los que `build_manifest` ya
 * produce -- ninguno inventado. Nota de nombres (confirmada leyendo
 * `manifest.py`/`builder.py`): el dict Python usa `inputFingerprint`/
 * `outputFingerprint` (sin el prefijo `dataset`), a diferencia de
 * `AiModelTrainingLineage.datasetInputFingerprint`/`datasetOutputFingerprint`
 * en TypeScript -- el worker hace ese mapeo explicito al construir el
 * lineage, nunca asume que los nombres de campo coinciden.
 */
export interface DatasetManifestCountsV1 {
  readonly battles: number
  readonly decisions: number
  readonly candidates: number
  readonly trainBattles: number
  readonly validationBattles: number
  readonly testBattles: number
  readonly trainDecisions: number
  readonly validationDecisions: number
  readonly testDecisions: number
}

export interface DatasetManifestV1 {
  readonly manifestVersion: string
  readonly featureSchemaVersion: string
  readonly featureDimension: number
  readonly teacherVersion: string
  readonly utilityVersion: string
  readonly cutoff: string
  readonly sourceCommit: string
  readonly datasetSeed: number
  readonly counts: DatasetManifestCountsV1
  readonly inputFingerprint: string
  readonly outputFingerprint: string
}

export const DATASET_MANIFEST_VERSION = 'dataset-manifest-v1'

const requireCounts = (value: unknown, field: string): DatasetManifestCountsV1 => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`"${field}" debe ser un objeto JSON.`)
  }
  const obj = value as Record<string, unknown>
  return {
    battles: requireNumber(obj.battles, `${field}.battles`),
    decisions: requireNumber(obj.decisions, `${field}.decisions`),
    candidates: requireNumber(obj.candidates, `${field}.candidates`),
    trainBattles: requireNumber(obj.trainBattles, `${field}.trainBattles`),
    validationBattles: requireNumber(obj.validationBattles, `${field}.validationBattles`),
    testBattles: requireNumber(obj.testBattles, `${field}.testBattles`),
    trainDecisions: requireNumber(obj.trainDecisions, `${field}.trainDecisions`),
    validationDecisions: requireNumber(obj.validationDecisions, `${field}.validationDecisions`),
    testDecisions: requireNumber(obj.testDecisions, `${field}.testDecisions`),
  }
}

/** Fail-closed ante cualquier campo faltante/con forma distinta -- nunca "arregla" un manifest incompleto. */
export const parseAndValidateDatasetManifest = (raw: unknown): DatasetManifestV1 => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('El dataset manifest debe ser un objeto JSON.')
  }
  const obj = raw as Record<string, unknown>
  const manifestVersion = requireString(obj.manifestVersion, 'manifestVersion')
  if (manifestVersion !== DATASET_MANIFEST_VERSION) {
    return fail(`"manifestVersion" = "${manifestVersion}" no es "${DATASET_MANIFEST_VERSION}".`)
  }

  return {
    manifestVersion,
    featureSchemaVersion: requireString(obj.featureSchemaVersion, 'featureSchemaVersion'),
    featureDimension: requireNumber(obj.featureDimension, 'featureDimension'),
    teacherVersion: requireString(obj.teacherVersion, 'teacherVersion'),
    utilityVersion: requireString(obj.utilityVersion, 'utilityVersion'),
    cutoff: requireString(obj.cutoff, 'cutoff'),
    sourceCommit: requireString(obj.sourceCommit, 'sourceCommit'),
    datasetSeed: requireNumber(obj.datasetSeed, 'datasetSeed'),
    counts: requireCounts(obj.counts, 'counts'),
    inputFingerprint: requireString(obj.inputFingerprint, 'inputFingerprint'),
    outputFingerprint: requireString(obj.outputFingerprint, 'outputFingerprint'),
  }
}

/**
 * Mismo criterio que `DatasetNotTrainableError` en Python
 * (`training/dataset_loader.py`): train/validation/test deben tener al
 * menos una decision cada uno. El worker comprueba esto ANTES de invocar
 * `nexus-combat-train` para no gastar un proceso Python completo (ni un
 * `--emit-identity-only`) en un dataset que de todas formas fallaria.
 */
export const isDatasetTrainable = (counts: DatasetManifestCountsV1): boolean =>
  counts.trainDecisions > 0 && counts.validationDecisions > 0 && counts.testDecisions > 0
