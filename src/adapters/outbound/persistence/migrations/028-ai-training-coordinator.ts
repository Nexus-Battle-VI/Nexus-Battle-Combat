import type { Db } from 'mongodb'

const textSchema = { bsonType: 'string', minLength: 1 } as const
const nonNegativeIntSchema = { bsonType: ['int', 'long'], minimum: 0 } as const

export const AI_TRAINING_COORDINATOR_DOC_ID = 'default'

interface CoordinatorSeedDocument {
  readonly _id: string
  readonly schemaVersion: number
  readonly requestedThrough: Date
  readonly processedThrough: Date
  readonly leaseState: 'IDLE' | 'CLAIMED'
  readonly leaseOwnerId: string | null
  readonly fencingToken: number
  readonly claimedAt: Date | null
  readonly heartbeatAt: Date | null
  readonly leaseExpiresAt: Date | null
  readonly lastRunOutcome: 'SUCCESS' | 'FAILED' | 'NOT_TRAINABLE' | null
  readonly lastRunAt: Date | null
  readonly lastRunModelVersion: string | null
  readonly lastFailureReasonCode: string | null
  readonly lastFailureReason: string | null
  readonly consecutiveFailureCount: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * Coordinacion del worker de reentrenamiento continuo (EN-037.2, Management
 * #571 §6): un UNICO documento singleton concentra el cursor de trabajo
 * pendiente (`requestedThrough`/`processedThrough`) y el lease/fencing
 * distribuido -- nunca dos colecciones separadas, para que cada transicion
 * sea una sola escritura Mongo atomica (ver
 * `ContinuousTrainingCoordinatorPort.ts`).
 *
 * No existe en Combat ningun lock distribuido reutilizable (`ChannelLock`
 * es en memoria, una sola replica, ADR-020): este es el primer primitivo de
 * coordinacion cruzando procesos que persiste en Mongo.
 */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('ai-training-coordinator', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: [
          '_id',
          'schemaVersion',
          'requestedThrough',
          'processedThrough',
          'leaseState',
          'leaseOwnerId',
          'fencingToken',
          'claimedAt',
          'heartbeatAt',
          'leaseExpiresAt',
          'lastRunOutcome',
          'lastRunAt',
          'lastRunModelVersion',
          'lastFailureReasonCode',
          'lastFailureReason',
          'consecutiveFailureCount',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          _id: textSchema,
          schemaVersion: { bsonType: 'int', enum: [1] },
          requestedThrough: { bsonType: 'date' },
          processedThrough: { bsonType: 'date' },
          leaseState: { bsonType: 'string', enum: ['IDLE', 'CLAIMED'] },
          leaseOwnerId: { oneOf: [{ bsonType: 'null' }, textSchema] },
          fencingToken: nonNegativeIntSchema,
          claimedAt: { oneOf: [{ bsonType: 'null' }, { bsonType: 'date' }] },
          heartbeatAt: { oneOf: [{ bsonType: 'null' }, { bsonType: 'date' }] },
          leaseExpiresAt: { oneOf: [{ bsonType: 'null' }, { bsonType: 'date' }] },
          lastRunOutcome: {
            oneOf: [
              { bsonType: 'null' },
              { bsonType: 'string', enum: ['SUCCESS', 'FAILED', 'NOT_TRAINABLE'] },
            ],
          },
          lastRunAt: { oneOf: [{ bsonType: 'null' }, { bsonType: 'date' }] },
          lastRunModelVersion: { oneOf: [{ bsonType: 'null' }, textSchema] },
          lastFailureReasonCode: {
            oneOf: [
              { bsonType: 'null' },
              {
                bsonType: 'string',
                enum: [
                  'DATASET_BUILD_FAILED',
                  'TRAINING_PROCESS_FAILED',
                  'ARTIFACT_INVALID',
                  'REGISTRY_REJECTED',
                  'LEASE_LOST',
                  'TRANSIENT_ERROR',
                ],
              },
            ],
          },
          lastFailureReason: { oneOf: [{ bsonType: 'null' }, { bsonType: 'string' }] },
          consecutiveFailureCount: nonNegativeIntSchema,
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  const now = new Date()
  await db.collection<CoordinatorSeedDocument>('ai-training-coordinator').insertOne({
    _id: AI_TRAINING_COORDINATOR_DOC_ID,
    schemaVersion: 1,
    // Epoch: nunca null (el validador lo exige como `date`), y cualquier
    // battle room real finalizo DESPUES del epoch -- el primer escaneo
    // real avanza esto de inmediato (#571 §5.1).
    requestedThrough: new Date(0),
    processedThrough: new Date(0),
    leaseState: 'IDLE',
    leaseOwnerId: null,
    fencingToken: 0,
    claimedAt: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    lastRunOutcome: null,
    lastRunAt: null,
    lastRunModelVersion: null,
    lastFailureReasonCode: null,
    lastFailureReason: null,
    consecutiveFailureCount: 0,
    createdAt: now,
    updatedAt: now,
  })
}
