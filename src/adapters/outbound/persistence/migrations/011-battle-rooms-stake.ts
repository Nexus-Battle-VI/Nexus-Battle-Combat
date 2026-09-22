import type { Db } from 'mongodb'

import { up as restoreFinishValidator } from './009-battle-rooms-finish'

/**
 * Amplia el validador `$jsonSchema` de `battle-rooms` con la apuesta de
 * creditos (HU-23, RF-23): `teams[].participants[].stake` opcional.
 *
 * ADITIVA Y RETROCOMPATIBLE, NO DESTRUCTIVA -- MISMO CRITERIO que `003`..`009`:
 * `stake` es OPCIONAL (no entra en `required`), porque los documentos escritos
 * por `009`/`010` no lo tienen y MongoDB no revalida en reposo lo ya
 * almacenado. Ningun documento necesita *backfill*: sin `stake` el participante
 * simplemente no aposto.
 *
 * `001`..`010` quedan CONGELADAS: esta es una migracion nueva. Es AUTOCONTENIDA
 * (no importa las constantes de `009`) para que una futura edicion de aquella no
 * cambie en silencio lo que esta aplica. El numero `011` es el siguiente libre.
 *
 * Los enteros usan `bsonType: 'number'`: el driver escribe los numeros de
 * JavaScript como `double` salvo que se envuelvan en `Int32`.
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
    /** HU-23: apuesta del participante; ausente = no aposto. */
    stake: {
      bsonType: 'object',
      required: ['amount', 'holdOperationId', 'status'],
      additionalProperties: false,
      properties: {
        amount: { bsonType: ['int', 'double'], minimum: 1 },
        holdOperationId: { bsonType: 'string', minLength: 1, maxLength: 200 },
        status: {
          enum: [
            'PENDING_RESERVE',
            'ACTIVE',
            'RESERVE_FAILED',
            'RELEASED',
            'CAPTURED',
            'SETTLED_WON',
          ],
        },
      },
    },
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

/** Costo de Poder de una habilidad (Catalog v1): un monto fijo o todos los puntos. */
const POWER_COST_SCHEMA = {
  bsonType: 'object',
  required: ['mode'],
  additionalProperties: false,
  properties: {
    mode: { enum: ['FIXED', 'ALL_AVAILABLE'] },
    amount: { bsonType: 'number', minimum: 1 },
  },
} as const

/** Habilidad especial congelada (HU-19): identidad, costo, recarga y efectos normalizados. */
const ABILITY_SCHEMA = {
  bsonType: 'object',
  required: ['abilityId', 'name', 'powerCost', 'chargeTurns', 'effects'],
  additionalProperties: false,
  properties: {
    abilityId: { bsonType: 'string', minLength: 1, maxLength: 100 },
    name: { bsonType: 'string', minLength: 1 },
    powerCost: POWER_COST_SCHEMA,
    chargeTurns: { bsonType: 'number', minimum: 1 },
    effects: { bsonType: 'array', items: { bsonType: 'object' } },
  },
} as const

/** Perfil de combate congelado (HU-18) mas el Poder maximo y las habilidades (HU-19). */
const COMBAT_PROFILE_SCHEMA = {
  bsonType: ['object', 'null'],
  required: ['heroId', 'subtype', 'maxHealth', 'attack', 'defense', 'damage', 'activeEffects'],
  additionalProperties: false,
  properties: {
    heroId: { bsonType: 'string', minLength: 1 },
    subtype: { bsonType: 'string', minLength: 1 },
    maxHealth: { bsonType: 'number', minimum: 0 },
    attack: { bsonType: ['number', 'null'], minimum: 0 },
    defense: { bsonType: 'number', minimum: 0 },
    damage: { bsonType: ['object', 'null'] },
    activeEffects: { bsonType: 'array', items: { bsonType: 'object' } },
    maxPower: { bsonType: 'number', minimum: 0 },
    abilities: { bsonType: 'array', items: ABILITY_SCHEMA },
  },
} as const

const COMBATANT_SCHEMA = {
  bsonType: 'object',
  required: ['teamLabel', 'seat', 'currentHealth', 'profile'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    seat: { bsonType: 'number', minimum: 0 },
    currentHealth: { bsonType: ['number', 'null'], minimum: 0 },
    profile: COMBAT_PROFILE_SCHEMA,
    currentPower: { bsonType: ['number', 'null'], minimum: 0 },
    cooldowns: { bsonType: 'object' },
  },
} as const

const BATTLE_SCHEMA = {
  bsonType: ['object', 'null'],
  required: ['startedAt', 'turnOrder', 'turnsCompleted'],
  additionalProperties: false,
  properties: {
    startedAt: { bsonType: 'date' },
    /** HU-21: inicio del turno vigente; opcional en batallas anteriores. */
    turnStartedAt: { bsonType: 'date' },
    turnOrder: { bsonType: 'array', minItems: 2, maxItems: 6, items: TURN_ORDER_ENTRY_SCHEMA },
    turnsCompleted: { bsonType: 'number', minimum: 0 },
    combatants: { bsonType: ['array', 'null'], maxItems: 6, items: COMBATANT_SCHEMA },
  },
} as const

/** Estado final de un equipo (contrato §5). */
const TEAM_STANDING_SCHEMA = {
  bsonType: 'object',
  required: ['teamLabel', 'remainingHealth', 'maxHealth', 'lifePercent', 'eliminated'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    remainingHealth: { bsonType: 'number', minimum: 0 },
    maxHealth: { bsonType: 'number', minimum: 0 },
    lifePercent: { bsonType: 'number', minimum: 0, maximum: 100 },
    eliminated: { bsonType: 'bool' },
  },
} as const

/** Resultado por participante (contrato §5). */
const PARTICIPANT_OUTCOME_SCHEMA = {
  bsonType: 'object',
  required: ['teamLabel', 'seat', 'kind', 'playerId', 'displayName', 'heroId', 'result'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    seat: { bsonType: 'number', minimum: 0 },
    kind: { enum: ['HUMAN', 'AI'] },
    playerId: { bsonType: ['string', 'null'] },
    displayName: { bsonType: ['string', 'null'] },
    heroId: { bsonType: ['string', 'null'] },
    result: { enum: ['WON', 'LOST', 'NO_WINNER'] },
  },
} as const

const DISCONNECTED_SCHEMA = {
  bsonType: ['object', 'null'],
  required: ['teamLabel', 'seat'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    seat: { bsonType: 'number', minimum: 0 },
  },
} as const

/** Resultado unico de la batalla (contrato §5): JSON puro, fechas ISO de texto. */
const BATTLE_RESULT_SCHEMA = {
  bsonType: 'object',
  required: [
    'reason',
    'outcome',
    'winnerTeamLabel',
    'finishedAt',
    'tiebreak',
    'disconnected',
    'teams',
    'participants',
  ],
  additionalProperties: false,
  properties: {
    reason: { enum: ['ELIMINATION', 'DISCONNECTION', 'TIME_LIMIT'] },
    outcome: { enum: ['WIN', 'NO_WINNER'] },
    winnerTeamLabel: { bsonType: ['string', 'null'] },
    finishedAt: { bsonType: 'string', minLength: 1 },
    tiebreak: { enum: ['LIFE_PERCENT', 'ABSOLUTE_LIFE', null] },
    disconnected: DISCONNECTED_SCHEMA,
    teams: { bsonType: 'array', minItems: 2, maxItems: 2, items: TEAM_STANDING_SCHEMA },
    participants: {
      bsonType: 'array',
      minItems: 1,
      maxItems: 6,
      items: PARTICIPANT_OUTCOME_SCHEMA,
    },
  },
} as const

const EVENT_SCHEMA = {
  bsonType: 'object',
  required: ['seq', 'type', 'occurredAt', 'payload'],
  additionalProperties: false,
  properties: {
    seq: { bsonType: 'number', minimum: 1 },
    type: {
      enum: [
        'battleStarted',
        'turnAdvanced',
        'basicAttackResolved',
        'skillUsed',
        'turnTimedOut',
        'battleFinished',
      ],
    },
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

const REQUIRED = ['_id', 'mode', 'status', 'teams', 'reward', 'createdBy', 'createdAt', 'version']

const VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: REQUIRED,
    additionalProperties: false,
    properties: {
      _id: { bsonType: 'string', minLength: 1 },
      mode: { enum: ['PVP', 'PVE'] },
      status: {
        enum: ['WAITING_FOR_PLAYERS', 'PREPARING', 'IN_BATTLE', 'FINISHED', 'CANCELLED'],
      },
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
      battle: BATTLE_SCHEMA,
      events: { bsonType: 'array', items: EVENT_SCHEMA },
      handledCommands: { bsonType: 'array', items: HANDLED_COMMAND_SCHEMA },
      /** HU-21: `null` mientras la batalla esta en curso; no nulo si y solo si FINISHED. */
      result: { ...BATTLE_RESULT_SCHEMA, bsonType: ['object', 'null'] },
    },
  },
}

export const up = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'battle-rooms',
    validator: VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  })
}

/** Vuelve al validador de `009`. Las salas con apuesta ya escritas no se reescriben. */
export const down = async (db: Db): Promise<void> => {
  await restoreFinishValidator(db)
}
