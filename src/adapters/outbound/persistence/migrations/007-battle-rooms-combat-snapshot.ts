import type { Db } from 'mongodb'

import { up as restoreBattleStateValidator } from './005-battle-rooms-battle-state'

/**
 * Amplia el validador `$jsonSchema` de `battle-rooms` para el ataque basico
 * (HU-18, RF-18): el snapshot de combate congelado y la Vida actual por
 * participante (`battle.combatants`) y el tipo de evento `basicAttackResolved`.
 *
 * ADITIVA Y RETROCOMPATIBLE, NO DESTRUCTIVA -- MISMO CRITERIO que `003`..`005`:
 * `battle.combatants` es OPCIONAL (no entra en `required`) porque los documentos
 * escritos por `005` no lo tienen y MongoDB no revalida en reposo lo ya almacenado.
 * Ningun documento necesita backfill: la capa de dominio restaura una batalla sin
 * `combatants` como "sin snapshot de combate" (no admite ataque) y NUNCA consulta a
 * Player-Inventory al restaurar. Los eventos ya guardados (`battleStarted`,
 * `turnAdvanced`) siguen siendo validos.
 *
 * `001`..`006` quedan CONGELADAS: esta es una migracion nueva. Es AUTOCONTENIDA (no
 * importa las constantes de `005`) para que una futura edicion de aquella no cambie
 * en silencio lo que esta aplica. El numero `007` es el siguiente libre: `006` la
 * usa el chat de HU-13.
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

/** Perfil de combate congelado (HU-18): solo lo que HU-20 y el dano necesitan. */
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
    combatants: { bsonType: ['array', 'null'], maxItems: 6, items: COMBATANT_SCHEMA },
  },
} as const

const EVENT_SCHEMA = {
  bsonType: 'object',
  required: ['seq', 'type', 'occurredAt', 'payload'],
  additionalProperties: false,
  properties: {
    seq: { bsonType: 'number', minimum: 1 },
    type: { enum: ['battleStarted', 'turnAdvanced', 'basicAttackResolved'] },
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
      status: { enum: ['WAITING_FOR_PLAYERS', 'PREPARING', 'IN_BATTLE', 'CANCELLED'] },
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

/** Vuelve al validador de `005`. Las batallas con `combatants` no se reescriben. */
export const down = async (db: Db): Promise<void> => {
  await restoreBattleStateValidator(db)
}
