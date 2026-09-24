import type { Db } from 'mongodb'

/** Durable operation fingerprints; no simulation result or invented combat data. */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('mission-simulation-intake', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'requestHash', 'receivedAt'],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', minLength: 1, maxLength: 300 },
          requestHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
          receivedAt: { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}

export const down = async (db: Db): Promise<void> => {
  await db.collection('mission-simulation-intake').drop()
}
