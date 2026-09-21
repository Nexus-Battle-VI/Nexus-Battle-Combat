import { DomainError } from '../errors/DomainError'

/**
 * Estado de una sala de batalla.
 *
 * `WAITING_FOR_PLAYERS` (unico estado que produce `BattleRoom.create()`),
 * `CANCELLED` (solo alcanzable por `BattleRoom.cancel()`), `PREPARING`
 * (HU-15.2, RF-15: se alcanza EN LA MISMA escritura que `BattleRoom.join()`
 * cuando el ultimo cupo total de la sala se ocupa) e `IN_BATTLE` (HU-17,
 * RF-17: se alcanza con `BattleRoom.startBattle()` desde `PREPARING`, cuando
 * la cola de turnos ya esta generada). `IN_BATTLE` es un estado en el que el
 * lobby ya no admite `join`, `leave` ni `cancel`; su salida (fin de batalla)
 * es de HU-21 y no existe todavia.
 */
export const BattleRoomStatus = {
  WaitingForPlayers: 'WAITING_FOR_PLAYERS',
  Preparing: 'PREPARING',
  InBattle: 'IN_BATTLE',
  Cancelled: 'CANCELLED',
} as const

export type BattleRoomStatus = (typeof BattleRoomStatus)[keyof typeof BattleRoomStatus]

const ALL_STATUSES: readonly BattleRoomStatus[] = [
  BattleRoomStatus.WaitingForPlayers,
  BattleRoomStatus.Preparing,
  BattleRoomStatus.InBattle,
  BattleRoomStatus.Cancelled,
]

export const parseBattleRoomStatus = (raw: unknown): BattleRoomStatus => {
  if (typeof raw !== 'string' || !(ALL_STATUSES as readonly string[]).includes(raw)) {
    throw new DomainError(`El estado de sala "${String(raw)}" no es reconocido.`)
  }

  return raw as BattleRoomStatus
}
