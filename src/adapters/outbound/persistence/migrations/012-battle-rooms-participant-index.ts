import type { Db } from 'mongodb'

/**
 * Indices para "mis salas activas" (`ListMyActiveBattleRooms`).
 *
 * Solo ADITIVA: crea dos indices compuestos sobre `battle-rooms`, uno por cada
 * rama del `$or` de `MongoBattleRoomRepository.findActiveByParticipant`:
 * - (`teams.participants.playerId`, `status`): salas donde participa;
 * - (`createdBy`, `status`): salas que creo y siguen esperando jugadores.
 *
 * No toca el validador `$jsonSchema` ni ningun documento existente.
 * `createIndex` con el mismo nombre y la misma clave es idempotente en el
 * motor, y el registro `_migrations` ya impide ejecutarla dos veces.
 */
export const PARTICIPANT_INDEX = 'teams.participants.playerId_1_status_1'
export const CREATOR_INDEX = 'createdBy_1_status_1'

export const up = async (db: Db): Promise<void> => {
  const rooms = db.collection('battle-rooms')

  await rooms.createIndex(
    { 'teams.participants.playerId': 1, status: 1 },
    { name: PARTICIPANT_INDEX },
  )
  await rooms.createIndex({ createdBy: 1, status: 1 }, { name: CREATOR_INDEX })
}

export const down = async (db: Db): Promise<void> => {
  const rooms = db.collection('battle-rooms')

  await rooms.dropIndex(CREATOR_INDEX)
  await rooms.dropIndex(PARTICIPANT_INDEX)
}
