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

const magnitudeSchema = {
  oneOf: [
    {
      bsonType: 'object',
      required: ['mode', 'amount'],
      additionalProperties: false,
      properties: {
        mode: { enum: ['FIXED'] },
        amount: { ...numberSchema, minimum: 0 },
      },
    },
    {
      bsonType: 'object',
      required: ['mode', 'basisPoints'],
      additionalProperties: false,
      properties: {
        mode: { enum: ['PERCENTAGE'] },
        basisPoints: { ...numberSchema, minimum: 0 },
      },
    },
    {
      bsonType: 'object',
      required: ['mode', 'count', 'sides'],
      additionalProperties: false,
      properties: {
        mode: { enum: ['DICE'] },
        count: { ...nonNegativeIntegerSchema },
        sides: { ...nonNegativeIntegerSchema, minimum: 1 },
      },
    },
  ],
} as const

const decisionEffectSchema = {
  bsonType: 'object',
  required: ['kind', 'target', 'hasActivationCondition'],
  additionalProperties: false,
  properties: {
    kind: textSchema,
    target: textSchema,
    statistic: textSchema,
    operation: textSchema,
    magnitude: magnitudeSchema,
    durationTurns: nonNegativeIntegerSchema,
    hasActivationCondition: { bsonType: 'bool' },
    immunityCode: textSchema,
  },
} as const

const powerCostSchema = {
  oneOf: [
    {
      bsonType: 'object',
      required: ['mode', 'amount'],
      additionalProperties: false,
      properties: {
        mode: { enum: ['FIXED'] },
        amount: { ...numberSchema, minimum: 0 },
      },
    },
    {
      bsonType: 'object',
      required: ['mode'],
      additionalProperties: false,
      properties: { mode: { enum: ['ALL_AVAILABLE'] } },
    },
  ],
} as const

const activeEffectSchema = {
  oneOf: [
    {
      bsonType: 'object',
      required: [
        'kind',
        'sourceAbilityId',
        'sourceCombatant',
        'statistic',
        'operation',
        'amount',
        'remainingOwnTurns',
      ],
      additionalProperties: false,
      properties: {
        kind: { enum: ['STAT'] },
        sourceAbilityId: textSchema,
        sourceCombatant: keySchema,
        statistic: textSchema,
        operation: textSchema,
        amount: numberSchema,
        remainingOwnTurns: nonNegativeIntegerSchema,
      },
    },
    {
      bsonType: 'object',
      required: ['kind', 'sourceAbilityId', 'sourceCombatant', 'immunityCode', 'remainingOwnTurns'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['IMMUNITY'] },
        sourceAbilityId: textSchema,
        sourceCombatant: keySchema,
        immunityCode: textSchema,
        remainingOwnTurns: nonNegativeIntegerSchema,
      },
    },
  ],
} as const

const nullableHealthOrPowerSchema = {
  oneOf: [
    { bsonType: 'null' },
    {
      bsonType: 'object',
      required: ['current', 'max'],
      additionalProperties: false,
      properties: {
        current: { ...numberSchema, minimum: 0 },
        max: { ...numberSchema, minimum: 0 },
      },
    },
  ],
} as const

const combatantSchema = {
  bsonType: 'object',
  required: [
    'identity',
    'kind',
    'heroSubtype',
    'health',
    'power',
    'attack',
    'defense',
    'damage',
    'level',
    'cooldowns',
    'abilities',
    'epic',
    'activeEffects',
    'damageMemory',
  ],
  additionalProperties: false,
  properties: {
    identity: keySchema,
    kind: { bsonType: 'string', enum: ['HUMAN', 'AI'] },
    heroSubtype: { bsonType: ['string', 'null'] },
    health: nullableHealthOrPowerSchema,
    power: nullableHealthOrPowerSchema,
    attack: { bsonType: ['int', 'long', 'double', 'decimal', 'null'] },
    defense: { bsonType: ['int', 'long', 'double', 'decimal', 'null'] },
    damage: { oneOf: [{ bsonType: 'null' }, magnitudeSchema] },
    level: { bsonType: ['int', 'long', 'null'], minimum: 1 },
    cooldowns: {
      bsonType: 'array',
      items: {
        bsonType: 'object',
        required: ['abilityId', 'remainingOwnTurns'],
        additionalProperties: false,
        properties: {
          abilityId: textSchema,
          remainingOwnTurns: nonNegativeIntegerSchema,
        },
      },
    },
    abilities: {
      bsonType: 'array',
      items: {
        bsonType: 'object',
        required: ['abilityId', 'powerCost', 'chargeTurns', 'effects'],
        additionalProperties: false,
        properties: {
          abilityId: textSchema,
          powerCost: powerCostSchema,
          chargeTurns: nonNegativeIntegerSchema,
          effects: { bsonType: 'array', items: decisionEffectSchema },
        },
      },
    },
    epic: {
      oneOf: [
        { bsonType: 'null' },
        {
          bsonType: 'object',
          required: ['epicId', 'powerCost', 'cooldownTurns', 'cooldownRemaining', 'effects'],
          additionalProperties: false,
          properties: {
            epicId: textSchema,
            powerCost: { ...numberSchema, minimum: 0 },
            cooldownTurns: nonNegativeIntegerSchema,
            cooldownRemaining: nonNegativeIntegerSchema,
            effects: { bsonType: 'array', items: decisionEffectSchema },
          },
        },
      ],
    },
    activeEffects: { bsonType: 'array', items: activeEffectSchema },
    damageMemory: {
      oneOf: [
        { bsonType: 'null' },
        {
          bsonType: 'object',
          required: ['amount', 'remainingOwnTurns'],
          additionalProperties: false,
          properties: {
            amount: numberSchema,
            remainingOwnTurns: nonNegativeIntegerSchema,
          },
        },
      ],
    },
  },
} as const

const stateSchema = {
  bsonType: 'object',
  required: ['schemaVersion', 'context', 'actor', 'allies', 'enemies'],
  additionalProperties: false,
  properties: {
    schemaVersion: { bsonType: 'int', enum: [1] },
    context: {
      bsonType: 'object',
      required: ['battleId', 'mode', 'round', 'turnsCompleted'],
      additionalProperties: false,
      properties: {
        battleId: textSchema,
        mode: { bsonType: 'string', enum: ['PVP', 'PVE'] },
        round: { ...nonNegativeIntegerSchema, minimum: 1 },
        turnsCompleted: nonNegativeIntegerSchema,
      },
    },
    actor: combatantSchema,
    allies: { bsonType: 'array', items: combatantSchema },
    enemies: { bsonType: 'array', minItems: 1, items: combatantSchema },
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

const outcomeSchema = {
  oneOf: [
    {
      bsonType: 'object',
      required: ['kind', 'reason', 'outcome', 'winnerTeamLabel'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['BATTLE'] },
        reason: { bsonType: 'string', enum: ['ELIMINATION', 'DISCONNECTION', 'TIME_LIMIT'] },
        outcome: { bsonType: 'string', enum: ['WIN', 'NO_WINNER'] },
        winnerTeamLabel: { bsonType: ['string', 'null'] },
      },
    },
    {
      bsonType: 'object',
      required: ['kind', 'outcome'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['MISSION'] },
        outcome: {
          bsonType: 'string',
          enum: ['HERO_VICTORIOUS', 'HERO_DEFEATED', 'TIME_BUDGET_EXHAUSTED'],
        },
      },
    },
  ],
} as const

/**
 * Dataset append-only de EN-035.4. El validador fija tanto el sobre versionado
 * como el contrato estratégico que consumirá el entrenamiento; cualquier
 * evolución incompatible exige una nueva `schemaVersion`.
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
          decisionSequence: nonNegativeIntegerSchema,
          actor: keySchema,
          decisionSource: {
            bsonType: 'string',
            enum: ['HUMAN', 'RULE_BASED', 'RANDOM', 'MCTS', 'NEURAL'],
          },
          stateBefore: stateSchema,
          legalActions: { bsonType: 'array', minItems: 1, items: actionSchema },
          selectedAction: actionSchema,
          outcome: outcomeSchema,
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
            not: { required: ['outcome'] },
          },
          {
            required: ['outcome'],
            properties: { eventType: { enum: ['COMBAT_DECISION_OUTCOME'] } },
            not: {
              anyOf: [
                { required: ['decisionSequence'] },
                { required: ['actor'] },
                { required: ['decisionSource'] },
                { required: ['stateBefore'] },
                { required: ['legalActions'] },
                { required: ['selectedAction'] },
              ],
            },
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
  await collection.createIndex({ schemaVersion: 1, occurredAt: 1 }, { name: 'schema_occurred_at' })
}
