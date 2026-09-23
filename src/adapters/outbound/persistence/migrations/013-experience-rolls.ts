import type { Db } from 'mongodb'

/**
 * Coleccion nueva de los lotes de tiradas de experiencia de HU-09
 * (`hu-09-experience-reward-v1` §5.2), Task HU-09.2.
 *
 * ADITIVA: `battle-rooms` y `reward-workflows` no se tocan. La recompensa de
 * experiencia de una mision no vive dentro del documento de la sala por el mismo
 * motivo que el chat de HU-13 (migracion 006) y el `RewardWorkflow` de HU-22
 * (migracion 010): la sala es de una batalla, y un lote de experiencia cubre
 * TODAS las derrotas de una mision, que son varias batallas.
 *
 * `_id` es el `operationId` del lote (`mission:{enrollmentId}:xp-rolls`), es
 * decir, TAMBIEN la clave de idempotencia del contrato: un reintento del mismo
 * lote encuentra el mismo `_id` y no produce tiradas nuevas. Por eso el indice
 * de `_id`, que MongoDB crea solo, es el unico que hace falta.
 *
 * `roll` se acota a `1..8` -- la cara de un `1d8` -- para que el validador
 * rechace en la Base una tirada imposible en lugar de confiar en que el
 * aplicativo la escriba bien. El tipo es `['int', 'double']` y NO `'int'`, por
 * el mismo motivo que documenta la migracion `011`: el driver escribe los
 * numeros de JavaScript como `double` salvo que se envuelvan en `Int32`, y
 * exigir `'int'` haria fallar la escritura del propio repositorio. La
 * integralidad del valor la comprueba ademas `experience-roll-mapping` al leer.
 *
 * `012` esta tomada (`012-battle-rooms-participant-index`): esta es la `013`, el
 * siguiente numero libre.
 */
const DEFEAT_SCHEMA = {
  bsonType: 'object',
  required: ['encounterId', 'enemyInstanceId', 'rivalRef', 'roll', 'persistedAt'],
  additionalProperties: false,
  properties: {
    /** Indice del encuentro dentro de la mision (el `encounter` del `combatLog` de HU-72). */
    encounterId: { bsonType: 'string', minLength: 1, maxLength: 100 },
    /** Instancia concreta del enemigo (`<enemyRef>#<n>`, el `combatant`). */
    enemyInstanceId: { bsonType: 'string', minLength: 1, maxLength: 200 },
    /** Arquetipo del enemigo: viaja para trazabilidad, NO identifica la derrota. */
    rivalRef: { bsonType: 'string', minLength: 1, maxLength: 200 },
    roll: { bsonType: ['int', 'double'], minimum: 1, maximum: 8 },
    persistedAt: { bsonType: 'date' },
  },
} as const

export const up = async (db: Db): Promise<void> => {
  await db.createCollection('experience-rolls', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'enrollmentId', 'simulationId', 'heroId', 'defeats', 'createdAt'],
        additionalProperties: false,
        properties: {
          /** El `operationId` del lote: `mission:{enrollmentId}:xp-rolls`. */
          _id: { bsonType: 'string', minLength: 1, maxLength: 300 },
          enrollmentId: { bsonType: 'string', minLength: 1, maxLength: 200 },
          simulationId: { bsonType: 'string', minLength: 1, maxLength: 200 },
          heroId: { bsonType: 'string', minLength: 1, maxLength: 200 },
          /**
           * Las derrotas del lote. `minItems: 1`: un lote vacio no tiene nada que
           * resolver y el contrato lo rechaza con `400 SCHEMA_INVALID`.
           */
          defeats: { bsonType: 'array', minItems: 1, items: DEFEAT_SCHEMA },
          createdAt: { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}

export const down = async (db: Db): Promise<void> => {
  await db.collection('experience-rolls').drop()
}
