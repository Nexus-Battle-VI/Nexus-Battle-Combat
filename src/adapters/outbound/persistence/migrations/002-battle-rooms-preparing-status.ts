import type { Db } from 'mongodb'

/**
 * Amplia el validador `$jsonSchema` de `battle-rooms` para admitir el estado
 * `PREPARING` (HU-15.2, RF-15: se alcanza cuando `BattleRoom.join()` ocupa el
 * ultimo cupo total de la sala).
 *
 * `001-battle-rooms.ts` queda CONGELADA (ver su propio comentario: "debe
 * seguir siendo ejecutable tal como se escribio"), asi que este cambio de
 * esquema es una migracion nueva, no una edicion de la anterior -- mismo
 * criterio que cualquier motor de migraciones versionadas. Usa `collMod`
 * porque `createCollection` fallaria contra una coleccion ya existente; el
 * resto del esquema (equipos, participantes, recompensa) no cambia, solo el
 * enum de `status`.
 */
const PARTICIPANT_SCHEMA = {
  bsonType: 'object',
  required: ['kind', 'playerId', 'heroId', 'joinedAt'],
  additionalProperties: false,
  properties: {
    kind: { enum: ['HUMAN', 'AI'] },
    playerId: { bsonType: ['string', 'null'], minLength: 1 },
    heroId: { bsonType: ['string', 'null'], minLength: 1 },
    joinedAt: { bsonType: 'date' },
  },
} as const

const TEAM_SCHEMA = {
  bsonType: 'object',
  required: ['label', 'capacity', 'participants'],
  additionalProperties: false,
  properties: {
    label: { bsonType: 'string', minLength: 1 },
    capacity: { bsonType: 'int', minimum: 1, maximum: 3 },
    participants: {
      bsonType: 'array',
      maxItems: 3,
      items: PARTICIPANT_SCHEMA,
    },
  },
} as const

export const up = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'battle-rooms',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'mode', 'status', 'teams', 'reward', 'createdBy', 'createdAt', 'version'],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', minLength: 1 },
          mode: { enum: ['PVP', 'PVE'] },
          // Unico cambio respecto a 001: se admite 'PREPARING' (HU-15.2).
          status: { enum: ['WAITING_FOR_PLAYERS', 'PREPARING', 'CANCELLED'] },
          teams: {
            bsonType: 'array',
            minItems: 2,
            maxItems: 2,
            items: TEAM_SCHEMA,
          },
          reward: {
            bsonType: 'object',
            required: ['amount'],
            additionalProperties: false,
            properties: {
              amount: { bsonType: ['int', 'double'], minimum: 0 },
            },
          },
          createdBy: { bsonType: 'string', minLength: 1 },
          createdAt: { bsonType: 'date' },
          version: { bsonType: 'int', minimum: 0 },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}

export const down = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'battle-rooms',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'mode', 'status', 'teams', 'reward', 'createdBy', 'createdAt', 'version'],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', minLength: 1 },
          mode: { enum: ['PVP', 'PVE'] },
          status: { enum: ['WAITING_FOR_PLAYERS', 'CANCELLED'] },
          teams: {
            bsonType: 'array',
            minItems: 2,
            maxItems: 2,
            items: TEAM_SCHEMA,
          },
          reward: {
            bsonType: 'object',
            required: ['amount'],
            additionalProperties: false,
            properties: {
              amount: { bsonType: ['int', 'double'], minimum: 0 },
            },
          },
          createdBy: { bsonType: 'string', minLength: 1 },
          createdAt: { bsonType: 'date' },
          version: { bsonType: 'int', minimum: 0 },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
