import type { Db } from 'mongodb'

/**
 * Amplia el validador `$jsonSchema` de `battle-rooms` para la batalla (HU-17,
 * RF-17): el estado `IN_BATTLE`, la cola de turnos inmutable (`battle`), la
 * bitacora de eventos con `seq` (`events`, ADR-020) y los comandos ya
 * procesados (`handledCommands`, deduplicacion por `commandId`).
 *
 * ADITIVA Y RETROCOMPATIBLE, NO DESTRUCTIVA -- MISMO CRITERIO que
 * `003`/`004`: los tres campos nuevos son OPCIONALES (no entran en `required`)
 * porque los documentos escritos por `001`..`004` no los tienen y MongoDB no
 * revalida en reposo lo ya almacenado. Ningun documento necesita backfill: la
 * capa de mapeo trata su ausencia como "sin batalla, sin eventos, sin
 * comandos".
 *
 * Los enteros nuevos usan `bsonType: 'number'` (int/long/double): el driver
 * escribe los numeros de JavaScript como `double` salvo que se envuelvan en
 * `Int32`, y estos campos no necesitan esa distincion.
 *
 * `001`..`004` quedan CONGELADAS: esta es una migracion nueva, no una edicion
 * de las anteriores.
 */
const PARTICIPANT_SCHEMA = {
  bsonType: 'object',
  required: ['kind', 'playerId', 'heroId', 'joinedAt'],
  additionalProperties: false,
  properties: {
    kind: { enum: ['HUMAN', 'AI'] },
    playerId: { bsonType: ['string', 'null'], minLength: 1 },
    heroId: { bsonType: ['string', 'null'], minLength: 1 },
    displayName: { bsonType: ['string', 'null'], minLength: 1 },
    heroLoadoutVersion: { bsonType: ['int', 'null'], minimum: 0 },
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
    participants: { bsonType: 'array', maxItems: 3, items: PARTICIPANT_SCHEMA },
  },
} as const

const TURN_ORDER_ENTRY_SCHEMA = {
  bsonType: 'object',
  required: ['teamLabel', 'seat', 'kind', 'playerId', 'displayName', 'heroId', 'heroSubtype'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    seat: { bsonType: 'number', minimum: 0 },
    kind: { enum: ['HUMAN', 'AI'] },
    playerId: { bsonType: ['string', 'null'] },
    displayName: { bsonType: ['string', 'null'] },
    heroId: { bsonType: ['string', 'null'] },
    heroSubtype: { bsonType: ['string', 'null'] },
  },
} as const

const BATTLE_SCHEMA = {
  bsonType: ['object', 'null'],
  required: ['startedAt', 'turnOrder', 'turnsCompleted'],
  additionalProperties: false,
  properties: {
    startedAt: { bsonType: 'date' },
    turnOrder: { bsonType: 'array', minItems: 2, maxItems: 6, items: TURN_ORDER_ENTRY_SCHEMA },
    turnsCompleted: { bsonType: 'number', minimum: 0 },
  },
} as const

const EVENT_SCHEMA = {
  bsonType: 'object',
  required: ['seq', 'type', 'occurredAt', 'payload'],
  additionalProperties: false,
  properties: {
    seq: { bsonType: 'number', minimum: 1 },
    type: { enum: ['battleStarted', 'turnAdvanced'] },
    occurredAt: { bsonType: 'date' },
    payload: { bsonType: 'object' },
  },
} as const

const HANDLED_COMMAND_SCHEMA = {
  bsonType: 'object',
  required: ['commandId', 'seq'],
  additionalProperties: false,
  properties: {
    commandId: { bsonType: 'string', minLength: 1, maxLength: 100 },
    seq: { bsonType: 'number', minimum: 1 },
  },
} as const

const baseProperties = (statuses: readonly string[]) => ({
  _id: { bsonType: 'string', minLength: 1 },
  mode: { enum: ['PVP', 'PVE'] },
  status: { enum: statuses },
  teams: { bsonType: 'array', minItems: 2, maxItems: 2, items: TEAM_SCHEMA },
  reward: {
    bsonType: 'object',
    required: ['amount'],
    additionalProperties: false,
    properties: { amount: { bsonType: ['int', 'double'], minimum: 0 } },
  },
  createdBy: { bsonType: 'string', minLength: 1 },
  createdAt: { bsonType: 'date' },
  version: { bsonType: 'int', minimum: 0 },
})

const REQUIRED = ['_id', 'mode', 'status', 'teams', 'reward', 'createdBy', 'createdAt', 'version']

const buildValidator = (withBattle: boolean) => ({
  $jsonSchema: {
    bsonType: 'object',
    required: REQUIRED,
    additionalProperties: false,
    properties: withBattle
      ? {
          ...baseProperties(['WAITING_FOR_PLAYERS', 'PREPARING', 'IN_BATTLE', 'CANCELLED']),
          battle: BATTLE_SCHEMA,
          events: { bsonType: 'array', items: EVENT_SCHEMA },
          handledCommands: { bsonType: 'array', items: HANDLED_COMMAND_SCHEMA },
        }
      : baseProperties(['WAITING_FOR_PLAYERS', 'PREPARING', 'CANCELLED']),
  },
})

export const up = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'battle-rooms',
    validator: buildValidator(true),
    validationLevel: 'strict',
    validationAction: 'error',
  })
}

export const down = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'battle-rooms',
    validator: buildValidator(false),
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
