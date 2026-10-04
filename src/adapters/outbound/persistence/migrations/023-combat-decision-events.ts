import type { Db } from 'mongodb'

const keySchema = {
  bsonType: 'object',
  required: ['teamLabel', 'seat'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    seat: { bsonType: 'int', minimum: 0 },
  },
} as const

/**
 * Dataset append-only de EN-035.4. El validador congela el sobre versionado y
 * deja los contratos internos `stateBefore`/acciones a sus tipos de dominio,
 * que evolucionan únicamente mediante una nueva `schemaVersion`.
 */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('combat-decision-events', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: ['_id', 'schemaVersion', 'eventType', 'battleId', 'origin', 'mode', 'occurredAt'],
        properties: {
          _id: { bsonType: 'string', minLength: 1, maxLength: 500 },
          schemaVersion: { bsonType: 'int', enum: [1] },
          eventType: {
            bsonType: 'string',
            enum: ['COMBAT_DECISION', 'COMBAT_DECISION_OUTCOME'],
          },
          battleId: { bsonType: 'string', minLength: 1, maxLength: 300 },
          origin: { bsonType: 'string', enum: ['ONLINE', 'MISSION', 'TOURNAMENT'] },
          mode: { bsonType: 'string', enum: ['PVP', 'PVE'] },
          occurredAt: { bsonType: 'date' },
          decisionSequence: { bsonType: 'int', minimum: 0 },
          actor: keySchema,
          decisionSource: {
            bsonType: 'string',
            enum: ['HUMAN', 'RULE_BASED', 'RANDOM', 'MCTS', 'NEURAL'],
          },
          stateBefore: { bsonType: 'object' },
          legalActions: { bsonType: 'array', minItems: 1, items: { bsonType: 'object' } },
          selectedAction: { bsonType: 'object' },
          outcome: { bsonType: 'object' },
        },
        oneOf: [
          {
            required: [
              'decisionSequence',
              'actor',
              'decisionSource',
              'stateBefore',
              'legalActions',
              'selectedAction',
            ],
            properties: { eventType: { enum: ['COMBAT_DECISION'] } },
          },
          {
            required: ['outcome'],
            properties: { eventType: { enum: ['COMBAT_DECISION_OUTCOME'] } },
          },
        ],
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  const collection = db.collection('combat-decision-events')
  await collection.createIndex(
    { origin: 1, battleId: 1, decisionSequence: 1 },
    {
      name: 'decision_sequence_unique',
      unique: true,
      partialFilterExpression: { eventType: 'COMBAT_DECISION' },
    },
  )
  await collection.createIndex(
    { origin: 1, battleId: 1 },
    {
      name: 'outcome_unique',
      unique: true,
      partialFilterExpression: { eventType: 'COMBAT_DECISION_OUTCOME' },
    },
  )
  await collection.createIndex({ occurredAt: 1 }, { name: 'occurred_at' })
}
