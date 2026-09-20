import type { Db } from 'mongodb'

/**
 * Amplia el validador `$jsonSchema` de `battle-rooms` para admitir
 * `displayName` en cada participante (HU-15.2, RF-15, DP-2: snapshot del
 * nombre visible resuelto de Account al unirse).
 *
 * ADITIVA Y RETROCOMPATIBLE, NO DESTRUCTIVA: `displayName` se declara
 * OPCIONAL (no se agrega a `required`) precisamente porque los documentos
 * escritos por `001`/`002` no lo tienen y MongoDB no revalida en reposo los
 * documentos ya almacenados -- solo los que se inserten o reemplacen desde
 * ahora. Ningun documento existente necesita reescribirse ni backfill: la
 * capa de mapeo (`battle-room-mapping.ts::toSnapshot`) ya trata su ausencia
 * como `null`, y el dominio (`Participant.ts`, `BattleRoom.join()`) ya trata
 * `displayName === null` como "sin nombre resuelto" (participantes `AI`, o
 * `HUMAN` incorporados antes de esta version via `initialParticipants` de
 * HU-14) sin lanzar ni excluir de la comprobacion de unicidad.
 *
 * `002-battle-rooms-preparing-status.ts` queda CONGELADA por el mismo motivo
 * que `001`: es una migracion nueva, no una edicion de la anterior.
 */
const PARTICIPANT_SCHEMA = {
  bsonType: 'object',
  required: ['kind', 'playerId', 'heroId', 'joinedAt'],
  additionalProperties: false,
  properties: {
    kind: { enum: ['HUMAN', 'AI'] },
    playerId: { bsonType: ['string', 'null'], minLength: 1 },
    heroId: { bsonType: ['string', 'null'], minLength: 1 },
    // Unico cambio respecto a 002: se admite `displayName`, opcional.
    displayName: { bsonType: ['string', 'null'], minLength: 1 },
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

const PARTICIPANT_SCHEMA_WITHOUT_DISPLAY_NAME = {
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

const TEAM_SCHEMA_WITHOUT_DISPLAY_NAME = {
  bsonType: 'object',
  required: ['label', 'capacity', 'participants'],
  additionalProperties: false,
  properties: {
    label: { bsonType: 'string', minLength: 1 },
    capacity: { bsonType: 'int', minimum: 1, maximum: 3 },
    participants: {
      bsonType: 'array',
      maxItems: 3,
      items: PARTICIPANT_SCHEMA_WITHOUT_DISPLAY_NAME,
    },
  },
} as const

const buildValidator = (
  teamSchema: typeof TEAM_SCHEMA | typeof TEAM_SCHEMA_WITHOUT_DISPLAY_NAME,
) => ({
  $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'mode', 'status', 'teams', 'reward', 'createdBy', 'createdAt', 'version'],
    additionalProperties: false,
    properties: {
      _id: { bsonType: 'string', minLength: 1 },
      mode: { enum: ['PVP', 'PVE'] },
      status: { enum: ['WAITING_FOR_PLAYERS', 'PREPARING', 'CANCELLED'] },
      teams: {
        bsonType: 'array',
        minItems: 2,
        maxItems: 2,
        items: teamSchema,
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
})

export const up = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'battle-rooms',
    validator: buildValidator(TEAM_SCHEMA),
    validationLevel: 'strict',
    validationAction: 'error',
  })
}

export const down = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'battle-rooms',
    validator: buildValidator(TEAM_SCHEMA_WITHOUT_DISPLAY_NAME),
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
