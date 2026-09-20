import type { Db } from 'mongodb'

/**
 * Amplia el validador `$jsonSchema` de `battle-rooms` para admitir
 * `heroLoadoutVersion` en cada participante (HU-16.2, RF-16,
 * Management#25/#401/#402; DP-6 de la auditoria HU-16.1: captura de la
 * version de `HeroLoadout` de Player-Inventory en el momento de unirse,
 * para poder detectar mas tarde que la configuracion aprobada cambio).
 *
 * ADITIVA Y RETROCOMPATIBLE, NO DESTRUCTIVA -- MISMO CRITERIO que
 * `003-battle-rooms-participant-display-name.ts` para `displayName`:
 * `heroLoadoutVersion` se declara OPCIONAL (no se agrega a `required`)
 * porque los documentos escritos por `001`/`002`/`003` no lo tienen y
 * MongoDB no revalida en reposo los documentos ya almacenados. Ningun
 * documento existente necesita reescribirse ni backfill: la capa de mapeo
 * (`battle-room-mapping.ts::toSnapshot`) ya trata su ausencia como `null`, y
 * el dominio (`Participant.ts`) ya trata `heroLoadoutVersion === null` como
 * "sin version capturada" (participantes `AI`, o `HUMAN` incorporados antes
 * de esta version) sin lanzar.
 *
 * `003-battle-rooms-participant-display-name.ts` queda CONGELADA por el
 * mismo motivo que `001`/`002`: es una migracion nueva, no una edicion de
 * la anterior.
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
    // Unico cambio respecto a 003: se admite `heroLoadoutVersion`, opcional.
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
    participants: {
      bsonType: 'array',
      maxItems: 3,
      items: PARTICIPANT_SCHEMA,
    },
  },
} as const

const PARTICIPANT_SCHEMA_WITHOUT_HERO_LOADOUT_VERSION = {
  bsonType: 'object',
  required: ['kind', 'playerId', 'heroId', 'joinedAt'],
  additionalProperties: false,
  properties: {
    kind: { enum: ['HUMAN', 'AI'] },
    playerId: { bsonType: ['string', 'null'], minLength: 1 },
    heroId: { bsonType: ['string', 'null'], minLength: 1 },
    displayName: { bsonType: ['string', 'null'], minLength: 1 },
    joinedAt: { bsonType: 'date' },
  },
} as const

const TEAM_SCHEMA_WITHOUT_HERO_LOADOUT_VERSION = {
  bsonType: 'object',
  required: ['label', 'capacity', 'participants'],
  additionalProperties: false,
  properties: {
    label: { bsonType: 'string', minLength: 1 },
    capacity: { bsonType: 'int', minimum: 1, maximum: 3 },
    participants: {
      bsonType: 'array',
      maxItems: 3,
      items: PARTICIPANT_SCHEMA_WITHOUT_HERO_LOADOUT_VERSION,
    },
  },
} as const

const buildValidator = (
  teamSchema: typeof TEAM_SCHEMA | typeof TEAM_SCHEMA_WITHOUT_HERO_LOADOUT_VERSION,
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
    validator: buildValidator(TEAM_SCHEMA_WITHOUT_HERO_LOADOUT_VERSION),
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
