import type { Db } from 'mongodb'

/** Immutable result keyed by operationId; retries never reroll or replace it. */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('mission-simulation-results', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'requestHash', 'completedAt', 'result'],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', minLength: 1, maxLength: 300 },
          requestHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
          completedAt: { bsonType: 'date' },
          result: { bsonType: 'object' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
