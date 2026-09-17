import type { Db } from 'mongodb'

/**
 * Esquema de la sala de batalla (HU-14, RF-14).
 *
 * UN DOCUMENTO POR SALA, con el UUID v4 generado por el servidor como `_id`
 * — nunca un `ObjectId` autogenerado, mismo patron que `hero-selections` de
 * Player-Inventory. `teams` y `reward` viajan embebidos: son un unico
 * agregado y su escritura debe ser atomica.
 *
 * El validador vive en el MOTOR, igual que las migraciones de
 * Player-Inventory: es el equivalente de las restricciones `CHECK` de un
 * motor relacional, no una segunda comprobacion en la aplicacion. La suma
 * `Σ team.capacity <= 6` NO es expresable en `$jsonSchema` (no hay forma de
 * sumar campos de subdocumentos distintos en un validador de MongoDB); esa
 * invariante vive solo en el dominio (`BattleRoom.create()`/`restore()`) —
 * HU-14.1, `HU-14.1-Decisiones-Tecnicas.md`, punto 5.
 *
 * Indices: `status` (listado de disponibles) y compuesto `{status:1,
 * createdAt:-1}` (listado ordenado por recencia dentro de ese estado).
 *
 * `up` recibe `Db` a proposito: una migracion queda congelada y debe seguir
 * siendo ejecutable tal como se escribio.
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
    // El limite real 1..3 lo aplica el agregado; el motor solo acota el tipo.
    capacity: { bsonType: 'int', minimum: 1, maximum: 3 },
    participants: {
      bsonType: 'array',
      maxItems: 3,
      items: PARTICIPANT_SCHEMA,
    },
  },
} as const

export const up = async (db: Db): Promise<void> => {
  await db.createCollection('battle-rooms', {
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
          // Version del bloqueo optimista. `int` y no `double`.
          version: { bsonType: 'int', minimum: 0 },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  const rooms = db.collection('battle-rooms')

  await rooms.createIndex({ status: 1 }, { name: 'status_1' })
  await rooms.createIndex({ status: 1, createdAt: -1 }, { name: 'status_1_createdAt_-1' })
}

export const down = async (db: Db): Promise<void> => {
  await db.collection('battle-rooms').drop()
}
