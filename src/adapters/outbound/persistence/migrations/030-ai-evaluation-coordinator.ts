import type { Db } from 'mongodb'

const textSchema = { bsonType: 'string', minLength: 1 } as const
const sha256HexSchema = { bsonType: 'string', pattern: '^[0-9a-f]{64}$' } as const
const nonNegativeIntSchema = { bsonType: ['int', 'long'], minimum: 0 } as const
const nullableText = { oneOf: [{ bsonType: 'null' }, textSchema] } as const
const nullableSha256Hex = { oneOf: [{ bsonType: 'null' }, sha256HexSchema] } as const
const nullableDate = { oneOf: [{ bsonType: 'null' }, { bsonType: 'date' }] } as const

/**
 * Coordinacion de la evaluacion automatica (EN-037.3, Management #572
 * §7.3, §7.6): UN documento POR candidato (`_id = modelVersion`), nunca un
 * singleton global como `ai-training-coordinator` (#571 migracion `028`)
 * -- a diferencia del cursor continuo de batallas, el trabajo de #572 ya
 * esta partido de forma natural por `modelVersion` (cada `CANDIDATE` es su
 * propia unidad de trabajo), asi que un singleton global acoplaria
 * innecesariamente evaluaciones de candidatos distintos entre si. El
 * lease/fencing (`leaseState`/`leaseOwnerId`/`fencingToken`/`heartbeatAt`/
 * `leaseExpiresAt`) reutiliza el MISMO patron atomico de `028`, en una
 * coleccion propia -- revision de codigo de #571 (P1-3): reusar el
 * documento singleton del trainer habria acoplado semantica de cursor de
 * entrenamiento con semantica de evaluacion, dos conceptos sin relacion.
 *
 * Este documento es TAMBIEN el ledger de evidencia y auditoria exigido
 * por #572 §7.6/§12: cada decision de promocion/rechazo debe poder
 * reconstruirse sin depender solo de logs.
 */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('ai-model-evaluations', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: [
          '_id',
          'schemaVersion',
          'trainingRunId',
          'modelStateSha256',
          'onnxArtifactSha256',
          'parityReferenceSha256',
          'leaseState',
          'leaseOwnerId',
          'fencingToken',
          'claimedAt',
          'heartbeatAt',
          'leaseExpiresAt',
          'status',
          'evaluationId',
          'evaluationOutcome',
          'gateResults',
          'failureReasons',
          'previousActiveVersion',
          'promotionStatus',
          'promotionPolicyVersion',
          'evaluationConfigVersion',
          'sourceCommit',
          'seedSetSha256',
          'matchesSha256',
          'evaluationConfigSha256',
          'consecutiveFailureCount',
          'evaluatedAt',
          'rollbackHistory',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          // `modelVersion` del candidato evaluado (#570 §17: igual a `trainingRunId`).
          _id: textSchema,
          schemaVersion: { bsonType: 'int', enum: [1] },
          trainingRunId: textSchema,
          modelStateSha256: sha256HexSchema,
          onnxArtifactSha256: sha256HexSchema,
          parityReferenceSha256: sha256HexSchema,
          leaseState: { bsonType: 'string', enum: ['IDLE', 'CLAIMED'] },
          leaseOwnerId: nullableText,
          fencingToken: nonNegativeIntSchema,
          claimedAt: nullableDate,
          heartbeatAt: nullableDate,
          leaseExpiresAt: nullableDate,
          status: { bsonType: 'string', enum: ['PENDING', 'EVALUATING', 'DECIDED'] },
          // Deterministico (#572 §13): sha256(modelVersion + evaluationConfigSha256 +
          // previousActiveVersion); nunca un timestamp arbitrario. `null` hasta la
          // primera corrida real del harness.
          evaluationId: nullableText,
          evaluationOutcome: {
            oneOf: [
              { bsonType: 'null' },
              { bsonType: 'string', enum: ['PASS', 'FAIL', 'INFRASTRUCTURE_FAILURE'] },
            ],
          },
          // Opaco (mismo criterio que `metrics`/`trainingConfig` de #570): la
          // infraestructura nunca interpreta su contenido, solo lo persiste para
          // auditoria/reproducibilidad del resultado de `PromotionPolicyV1`.
          gateResults: { bsonType: 'array' },
          failureReasons: { bsonType: 'array', items: textSchema },
          previousActiveVersion: nullableText,
          promotionStatus: {
            bsonType: 'string',
            enum: ['NOT_APPLICABLE', 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'],
          },
          promotionPolicyVersion: nullableText,
          evaluationConfigVersion: nullableText,
          sourceCommit: nullableText,
          seedSetSha256: nullableSha256Hex,
          matchesSha256: nullableSha256Hex,
          evaluationConfigSha256: nullableSha256Hex,
          consecutiveFailureCount: nonNegativeIntSchema,
          evaluatedAt: nullableDate,
          // Auditoria de rollback estricta e idempotente (#572 §10): el
          // `rollbackId` identifica reintentos del mismo comando protegido.
          rollbackHistory: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              additionalProperties: false,
              required: ['rollbackId', 'fromVersion', 'reason', 'at'],
              properties: {
                rollbackId: textSchema,
                fromVersion: textSchema,
                reason: textSchema,
                at: { bsonType: 'date' },
              },
            },
          },
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  const evaluations = db.collection('ai-model-evaluations')
  await evaluations.createIndex({ status: 1 }, { name: 'status_lookup' })
}
