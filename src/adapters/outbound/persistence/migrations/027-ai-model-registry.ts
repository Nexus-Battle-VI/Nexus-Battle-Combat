import type { Db } from 'mongodb'

const textSchema = { bsonType: 'string', minLength: 1 } as const
const sha256HexSchema = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{64}$',
} as const
const nonNegativeIntSchema = { bsonType: ['int', 'long'], minimum: 0 } as const

const trainingLineageSchema = {
  bsonType: 'object',
  additionalProperties: false,
  required: [
    'modelVersion',
    'trainingRunId',
    'modelArchitectureVersion',
    'featureSchemaVersion',
    'teacherVersion',
    'utilityVersion',
    'trainingSourceCommit',
    'datasetSourceCommit',
    'datasetInputFingerprint',
    'datasetOutputFingerprint',
    'datasetCutoff',
    'datasetSeed',
    'trainingSeed',
    'trainingConfigSha256',
  ],
  properties: {
    modelVersion: textSchema,
    trainingRunId: textSchema,
    modelArchitectureVersion: textSchema,
    featureSchemaVersion: textSchema,
    teacherVersion: textSchema,
    utilityVersion: textSchema,
    trainingSourceCommit: textSchema,
    datasetSourceCommit: textSchema,
    datasetInputFingerprint: sha256HexSchema,
    datasetOutputFingerprint: sha256HexSchema,
    datasetCutoff: textSchema,
    datasetSeed: nonNegativeIntSchema,
    // Distinto de `datasetSeed` (revision de codigo, #570): gobierna
    // PyTorch/DataLoader/entrenamiento, nunca el split/build del dataset.
    trainingSeed: nonNegativeIntSchema,
    trainingConfigSha256: sha256HexSchema,
  },
} as const

const artifactLineageSchema = {
  oneOf: [
    { bsonType: 'null' },
    {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'modelStateSha256',
        'onnxArtifactSha256',
        'pytorchArtifactSha256',
        'metricsFileSha256',
        'artifactPurpose',
        'trainingManifestSha256',
        'trainingConfig',
        'datasetCounts',
        'metrics',
      ],
      properties: {
        modelStateSha256: sha256HexSchema,
        onnxArtifactSha256: sha256HexSchema,
        pytorchArtifactSha256: sha256HexSchema,
        metricsFileSha256: sha256HexSchema,
        // Revision de codigo (#570): `registerCandidate` exige CANDIDATE --
        // SMOKE_TEST nunca llega a persistirse con un artifactLineage no
        // nulo, asi que el validador tambien lo exige como defensa extra.
        artifactPurpose: { bsonType: 'string', enum: ['CANDIDATE'] },
        trainingManifestSha256: sha256HexSchema,
        // Opaco (#570): el registry nunca interpreta su contenido salvo
        // para extraer `trainingConfig.trainingSeed`, solo lo persiste
        // para auditoria/reproducibilidad.
        trainingConfig: { bsonType: 'object' },
        datasetCounts: { bsonType: 'object' },
        metrics: { bsonType: 'object' },
      },
    },
  ],
} as const

const stateHistoryEntrySchema = {
  bsonType: 'object',
  additionalProperties: false,
  required: ['to', 'at'],
  properties: {
    from: {
      oneOf: [
        { bsonType: 'null' },
        { bsonType: 'string', enum: ['TRAINING', 'CANDIDATE', 'EVALUATING', 'ACTIVE', 'REJECTED'] },
      ],
    },
    to: { bsonType: 'string', enum: ['TRAINING', 'CANDIDATE', 'EVALUATING', 'ACTIVE', 'REJECTED'] },
    at: { bsonType: 'date' },
  },
} as const

const rejectionSchema = {
  oneOf: [
    { bsonType: 'null' },
    {
      bsonType: 'object',
      additionalProperties: false,
      required: ['reasonCode', 'reason', 'rejectedAt'],
      properties: {
        reasonCode: {
          bsonType: 'string',
          enum: ['TRAINING_FAILED', 'ARTIFACT_INVALID', 'SCHEMA_INCOMPATIBLE', 'EVALUATION_FAILED'],
        },
        reason: textSchema,
        rejectedAt: { bsonType: 'date' },
      },
    },
  ],
} as const

/**
 * Model registry de IA (EN-037.1, Management #570). Dos colecciones
 * separadas a proposito (#570 §31): `ai-model-versions` (metadata +
 * ciclo de vida, mutable, pequena) y `ai-model-artifacts` (binario
 * inmutable, content-addressed) -- nunca mezclan el documento de estado
 * con el peso binario del modelo.
 *
 * `ai-model-artifacts` usa BSON `Binary` en vez de GridFS (#570 §26-30,
 * ver `docs/en-037-model-registry.md` para la medicion completa): el
 * `model.onnx` real de `candidate-mlp-v1` pesa ~37KB, muy por debajo del
 * limite de documento de MongoDB (16MB) incluso con margen generoso para
 * arquitecturas futuras mas grandes. GridFS fragmenta en chunks de 255KB
 * y anade una segunda coleccion (`fs.chunks`) solo quando el documento no
 * entra en el limite -- introducirlo aqui seria complejidad sin
 * necesidad demostrada.
 */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('ai-model-versions', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: [
          '_id',
          'schemaVersion',
          'state',
          'revision',
          'trainingLineage',
          'artifactLineage',
          'stateHistory',
          'rejection',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          _id: textSchema,
          schemaVersion: { bsonType: 'int', enum: [1] },
          state: {
            bsonType: 'string',
            enum: ['TRAINING', 'CANDIDATE', 'EVALUATING', 'ACTIVE', 'REJECTED'],
          },
          revision: nonNegativeIntSchema,
          trainingLineage: trainingLineageSchema,
          artifactLineage: artifactLineageSchema,
          stateHistory: { bsonType: 'array', minItems: 1, items: stateHistoryEntrySchema },
          rejection: rejectionSchema,
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  const versions = db.collection('ai-model-versions')
  await versions.createIndex(
    { 'trainingLineage.trainingRunId': 1 },
    { name: 'training_run_id_unique', unique: true },
  )
  await versions.createIndex(
    { 'artifactLineage.modelStateSha256': 1 },
    { name: 'model_state_sha256' },
  )
  // Enforza en el motor (#570 §41-42) que como maximo una version este
  // ACTIVE a la vez -- nunca confiar solo en `findActive()` + `if null,
  // activate()` a nivel de aplicacion, eso es una condicion de carrera
  // entre procesos.
  await versions.createIndex(
    { state: 1 },
    { name: 'active_unique', unique: true, partialFilterExpression: { state: 'ACTIVE' } },
  )

  await db.createCollection('ai-model-artifacts', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: ['_id', 'schemaVersion', 'artifactType', 'sizeBytes', 'bytes', 'createdAt'],
        properties: {
          _id: sha256HexSchema,
          schemaVersion: { bsonType: 'int', enum: [1] },
          artifactType: { bsonType: 'string', enum: ['ONNX_MODEL'] },
          sizeBytes: { bsonType: ['int', 'long'], minimum: 1 },
          bytes: { bsonType: 'binData' },
          createdAt: { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
