import type { Db } from 'mongodb'

export const up = async (db: Db): Promise<void> => {
  await db.createCollection('battle-drop-workflows', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          '_id',
          'id',
          'battleId',
          'defeatEventSeq',
          'killerPlayerId',
          'defeatedPlayerId',
          'resolution',
          'state',
          'receipt',
          'winnerNotified',
          'loserNotified',
          'createdAt',
          'updatedAt',
        ],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', minLength: 1 },
          id: { bsonType: 'string', minLength: 1 },
          battleId: { bsonType: 'string', minLength: 1 },
          defeatEventSeq: { bsonType: 'int', minimum: 1 },
          killerPlayerId: { bsonType: 'string', minLength: 1 },
          defeatedPlayerId: { bsonType: 'string', minLength: 1 },
          resolution: { bsonType: 'object' },
          state: {
            enum: ['NO_DROP', 'AWAITING_TIE_RULE', 'PENDING', 'CREDITED', 'FAILED_RETRYABLE'],
          },
          receipt: { bsonType: ['object', 'null'] },
          winnerNotified: { bsonType: 'bool' },
          loserNotified: { bsonType: 'bool' },
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' },
        },
      },
    },
  })
  await db.collection('battle-drop-workflows').createIndex({ state: 1, createdAt: 1 })
  await db
    .collection('battle-drop-workflows')
    .createIndex({ battleId: 1, defeatEventSeq: 1 }, { unique: true })
  await db.createCollection('battle-drop-settlements', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'closedAt'],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', minLength: 1 },
          closedAt: { bsonType: 'date' },
        },
      },
    },
  })
}
