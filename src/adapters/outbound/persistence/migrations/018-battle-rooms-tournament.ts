import type { Db } from 'mongodb'

/**
 * Anade `tournament` a `battle-rooms` (Management#517, EN de
 * `tournament-rooms`) y el indice unico que sostiene su idempotencia de
 * creacion.
 *
 * ADITIVA Y RETROCOMPATIBLE -- MISMO CRITERIO que `003`..`017`: `tournament`
 * es OPCIONAL (no entra en `required`) y ningun documento existente necesita
 * backfill; un documento sin el campo se restaura como `null` (sala de
 * lobby, HU-14).
 *
 * NO REPITE EL VALIDADOR ENTERO (como `017`): lee el validador VIGENTE de la
 * coleccion y anade la propiedad unicamente en el nivel raiz del esquema, que
 * es donde vive `status`/`createdBy`/etc. Es idempotente: una segunda
 * ejecucion no vuelve a anadir la propiedad.
 *
 * El indice es PARCIAL (solo documentos con `tournament.operationId`) y
 * UNICO: es el mecanismo real de exclusion mutua de `CreateTournamentRoom` --
 * dos inserciones concurrentes con el MISMO `operationId` no pueden progresar
 * ambas, sin importar que generen `_id` (roomId) distintos.
 */
const TOURNAMENT_SCHEMA = {
  bsonType: ['object', 'null'],
  required: ['operationId', 'tournamentId', 'encounterId', 'requestHash'],
  additionalProperties: false,
  properties: {
    operationId: { bsonType: 'string', minLength: 1 },
    tournamentId: { bsonType: 'string', minLength: 1 },
    encounterId: { bsonType: 'string', minLength: 1 },
    requestHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
  },
} as const

export const TOURNAMENT_OPERATION_INDEX = 'tournament.operationId_1'

type Schema = Record<string, unknown>

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const up = async (db: Db): Promise<void> => {
  const [info] = await db.listCollections({ name: 'battle-rooms' }).toArray()
  const options = (info as { options?: Schema } | undefined)?.options
  const validator = options?.validator

  if (!isRecord(validator)) {
    throw new Error('battle-rooms no tiene un validador $jsonSchema que ampliar.')
  }

  const schema = validator.$jsonSchema

  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new Error('battle-rooms no tiene un $jsonSchema con "properties" que ampliar.')
  }

  if (!('tournament' in schema.properties)) {
    await db.command({
      collMod: 'battle-rooms',
      validator: {
        $jsonSchema: {
          ...schema,
          properties: { ...schema.properties, tournament: TOURNAMENT_SCHEMA },
        },
      },
      validationLevel:
        typeof options?.validationLevel === 'string' ? options.validationLevel : 'strict',
      validationAction:
        typeof options?.validationAction === 'string' ? options.validationAction : 'error',
    })
  }

  await db.collection('battle-rooms').createIndex(
    { 'tournament.operationId': 1 },
    {
      name: TOURNAMENT_OPERATION_INDEX,
      unique: true,
      partialFilterExpression: { 'tournament.operationId': { $exists: true } },
    },
  )
}

export const down = async (db: Db): Promise<void> => {
  await db.collection('battle-rooms').dropIndex(TOURNAMENT_OPERATION_INDEX)
}
