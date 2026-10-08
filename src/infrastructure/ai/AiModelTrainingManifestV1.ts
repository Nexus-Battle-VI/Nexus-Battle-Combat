import {
  fail,
  parseAndValidateTrainingManifest,
  requireNumber,
  requireString,
  type NeuralTrainingManifestV1,
} from './NeuralTrainingManifestV1'

/**
 * Superconjunto de `NeuralTrainingManifestV1` (EN-037.1, Management #570
 * §20-21): el runtime loader de #568 solo necesita el subconjunto que ya
 * valida `parseAndValidateTrainingManifest` (reutilizado aqui tal cual,
 * #570 §36 -- nunca copiado); el model registry ADEMAS necesita los
 * campos de provenance/training reales para que `#571`/`#572` puedan
 * comprobar procedencia despues (#570 §60).
 *
 * Todos los campos de este archivo son EXACTAMENTE los que
 * `training-manifest-v1` ya produce hoy (confirmado contra un
 * `training-manifest.json` real de `#567`, #570 §21) -- ninguno
 * inventado. `trainingConfig`/`datasetCounts` se conservan como objetos
 * OPACOS (igual criterio que `CombatEpic.baseEffect` en #567/#568): el
 * registry nunca interpreta su contenido, solo lo persiste para
 * auditoria.
 */
export interface AiModelTrainingManifestV1 extends NeuralTrainingManifestV1 {
  readonly decisionStateSchemaVersion: number
  readonly teacherVersion: string
  readonly utilityVersion: string
  readonly labelSchemaVersion: string
  readonly datasetManifestVersion: string
  readonly datasetInputFingerprint: string
  readonly datasetOutputFingerprint: string
  readonly datasetSourceCommit: string
  readonly datasetCutoff: string
  readonly datasetSeed: number
  readonly datasetCounts: Readonly<Record<string, unknown>>
  readonly trainingSourceCommit: string
  readonly pythonVersion: string
  readonly torchVersion: string
  readonly numpyVersion: string
  readonly onnxVersion: string
  readonly trainingConfig: Readonly<Record<string, unknown>>
  readonly trainingConfigSha256: string
  readonly bestEpoch: number
  readonly epochsRun: number
  readonly stoppedEarly: boolean
  readonly trainableParameterCount: number
  readonly pytorchArtifactSha256: string
  readonly metricsFileSha256: string
}

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') fail(`"${field}" debe ser booleano.`)
  return value as boolean
}

const requireOpaqueRecord = (value: unknown, field: string): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`"${field}" debe ser un objeto JSON.`)
  }
  return value as Readonly<Record<string, unknown>>
}

/**
 * Parsea Y valida el manifest completo (EN-037.1, #570 §20, §36):
 * primero delega en `parseAndValidateTrainingManifest` (contrato de
 * runtime congelado por #567, nunca re-implementado aqui), despues
 * extrae y valida ADEMAS los campos de provenance que el registry
 * necesita. Mismo criterio fail-closed: lanza `NeuralModelSchemaMismatchError`
 * ante el primer campo invalido, nunca acepta un manifest "parecido".
 */
export const parseAndValidateModelTrainingManifest = (raw: unknown): AiModelTrainingManifestV1 => {
  const runtimeContract = parseAndValidateTrainingManifest(raw)

  // `parseAndValidateTrainingManifest` ya confirmo que `raw` es un objeto.
  const obj = raw as Record<string, unknown>

  return {
    ...runtimeContract,
    decisionStateSchemaVersion: requireNumber(
      obj.decisionStateSchemaVersion,
      'decisionStateSchemaVersion',
    ),
    teacherVersion: requireString(obj.teacherVersion, 'teacherVersion'),
    utilityVersion: requireString(obj.utilityVersion, 'utilityVersion'),
    labelSchemaVersion: requireString(obj.labelSchemaVersion, 'labelSchemaVersion'),
    datasetManifestVersion: requireString(obj.datasetManifestVersion, 'datasetManifestVersion'),
    datasetInputFingerprint: requireString(obj.datasetInputFingerprint, 'datasetInputFingerprint'),
    datasetOutputFingerprint: requireString(
      obj.datasetOutputFingerprint,
      'datasetOutputFingerprint',
    ),
    datasetSourceCommit: requireString(obj.datasetSourceCommit, 'datasetSourceCommit'),
    datasetCutoff: requireString(obj.datasetCutoff, 'datasetCutoff'),
    datasetSeed: requireNumber(obj.datasetSeed, 'datasetSeed'),
    datasetCounts: requireOpaqueRecord(obj.datasetCounts, 'datasetCounts'),
    trainingSourceCommit: requireString(obj.trainingSourceCommit, 'trainingSourceCommit'),
    pythonVersion: requireString(obj.pythonVersion, 'pythonVersion'),
    torchVersion: requireString(obj.torchVersion, 'torchVersion'),
    numpyVersion: requireString(obj.numpyVersion, 'numpyVersion'),
    onnxVersion: requireString(obj.onnxVersion, 'onnxVersion'),
    trainingConfig: requireOpaqueRecord(obj.trainingConfig, 'trainingConfig'),
    trainingConfigSha256: requireString(obj.trainingConfigSha256, 'trainingConfigSha256'),
    bestEpoch: requireNumber(obj.bestEpoch, 'bestEpoch'),
    epochsRun: requireNumber(obj.epochsRun, 'epochsRun'),
    stoppedEarly: requireBoolean(obj.stoppedEarly, 'stoppedEarly'),
    trainableParameterCount: requireNumber(obj.trainableParameterCount, 'trainableParameterCount'),
    pytorchArtifactSha256: requireString(obj.pytorchArtifactSha256, 'pytorchArtifactSha256'),
    metricsFileSha256: requireString(obj.metricsFileSha256, 'metricsFileSha256'),
  }
}
