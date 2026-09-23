import type { Db } from 'mongodb'

/**
 * Indice para "mis salas activas" (`ListMyActiveBattleRooms`).
 *
 * Solo ADITIVA: crea un indice compuesto (`teams.participants.playerId`,
 * `status`) sobre `battle-rooms`. No toca el validador `$jsonSchema` ni ningun
 * documento existente. `createIndex` con el mismo nombre y la misma clave es
 * idempotente en el motor, y el registro `_migrations` ya impide ejecutarla
 * dos veces.
 */
export const INDEX_NAME = 'teams.participants.playerId_1_status_1'

export const up = async (db: Db): Promise<void> => {
  await db
    .collection('battle-rooms')
    .createIndex({ 'teams.participants.playerId': 1, status: 1 }, { name: INDEX_NAME })
}

export const down = async (db: Db): Promise<void> => {
  await db.collection('battle-rooms').dropIndex(INDEX_NAME)
}
