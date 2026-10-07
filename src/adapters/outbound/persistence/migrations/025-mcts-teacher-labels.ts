import type { Db } from 'mongodb'

const textSchema = { bsonType: 'string', minLength: 1 } as const
const integerSchema = { bsonType: ['int', 'long'] } as const
const nonNegativeIntegerSchema = { ...integerSchema, minimum: 0 } as const
const numberSchema = { bsonType: ['int', 'long', 'double', 'decimal'] } as const

const keySchema = {
  bsonType: 'object',
  required: ['teamLabel', 'seat'],
  additionalProperties: false,
  properties: {
    teamLabel: textSchema,
    seat: nonNegativeIntegerSchema,
  },
} as const

const targetSchema = {
  oneOf: [
    {
      bsonType: 'object',
      required: ['scope', 'combatant'],
      additionalProperties: false,
      properties: { scope: { enum: ['COMBATANT'] }, combatant: keySchema },
    },
    {
      bsonType: 'object',
      required: ['scope'],
      additionalProperties: false,
      properties: { scope: { enum: ['SELF'] } },
    },
    {
      bsonType: 'object',
      required: ['scope'],
      additionalProperties: false,
      properties: { scope: { enum: ['ALLIED_GROUP'] } },
    },
  ],
} as const

const actionSchema = {
  oneOf: [
    {
      bsonType: 'object',
      required: ['kind', 'target'],
      additionalProperties: false,
      properties: { kind: { enum: ['BASIC_ATTACK'] }, target: targetSchema },
    },
    {
      bsonType: 'object',
      required: ['kind', 'abilityId', 'target'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['ABILITY'] },
        abilityId: textSchema,
        target: targetSchema,
      },
    },
    {
      bsonType: 'object',
      required: ['kind', 'epicId', 'target'],
      additionalProperties: false,
      properties: { kind: { enum: ['EPIC'] }, epicId: textSchema, target: targetSchema },
    },
  ],
} as const

const candidateSchema = {
  bsonType: 'object',
  required: ['action', 'actionIdentity', 'visits', 'meanUtility', 'probability'],
  additionalProperties: false,
  properties: {
    action: actionSchema,
    actionIdentity: textSchema,
    visits: nonNegativeIntegerSchema,
    meanUtility: { ...numberSchema, minimum: 0, maximum: 1 },
    probability: { ...numberSchema, minimum: 0, maximum: 1 },
  },
} as const

const configSchema = {
  bsonType: 'object',
  required: [
    'teacherVersion',
    'utilityVersion',
    'rollouts',
    'maxDepthPlies',
    'explorationConstant',
    'rolloutPolicyVersion',
  ],
  additionalProperties: false,
  properties: {
    teacherVersion: { enum: ['mcts-teacher-v1'] },
    utilityVersion: { enum: ['pve-utility-v1'] },
    rollouts: { ...nonNegativeIntegerSchema, minimum: 1 },
    maxDepthPlies: { ...nonNegativeIntegerSchema, minimum: 1 },
    explorationConstant: { ...numberSchema, minimum: 0 },
    rolloutPolicyVersion: { enum: ['rule-based-v1'] },
  },
} as const

const resultSchema = {
  bsonType: 'object',
  required: ['config', 'simulationSeed', 'stateSchemaVersion', 'selectedAction', 'candidates'],
  additionalProperties: false,
  properties: {
    config: configSchema,
    simulationSeed: nonNegativeIntegerSchema,
    stateSchemaVersion: { bsonType: 'int', enum: [1] },
    selectedAction: actionSchema,
    candidates: { bsonType: 'array', minItems: 1, items: candidateSchema },
  },
} as const

/**
 * Dataset append-only del teacher label en vivo (EN-036.1 #565 + EN-036.2
 * #566, correccion de alcance sobre PR#81): liga, por `_id = eventId`, un
 * `MctsTeacherResult` ya ejecutado sobre el `BattleRoom` PRE-ACCION con la
 * decision real que lo origino. Nunca se actualiza ni se borra.
 */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('mcts-teacher-labels', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: [
          '_id',
          'schemaVersion',
          'battleId',
          'decisionSequence',
          'origin',
          'mode',
          'result',
          'generatedAt',
        ],
        properties: {
          _id: { bsonType: 'string', minLength: 1, maxLength: 500 },
          schemaVersion: { bsonType: 'int', enum: [1] },
          battleId: { bsonType: 'string', minLength: 1, maxLength: 300 },
          decisionSequence: nonNegativeIntegerSchema,
          origin: { bsonType: 'string', enum: ['ONLINE', 'MISSION', 'TOURNAMENT'] },
          mode: { bsonType: 'string', enum: ['PVP', 'PVE'] },
          result: resultSchema,
          generatedAt: { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  const collection = db.collection('mcts-teacher-labels')
  // `_id` ya es unico por construccion de Mongo; el indice compuesto respalda
  // ademas la invariante "a lo sumo un label por decision real" y las
  // lecturas del dataset Python ordenadas por battleId/decisionSequence.
  await collection.createIndex(
    { battleId: 1, decisionSequence: 1 },
    { name: 'battle_decision_sequence_unique', unique: true },
  )
  await collection.createIndex({ generatedAt: 1 }, { name: 'generated_at' })
}
