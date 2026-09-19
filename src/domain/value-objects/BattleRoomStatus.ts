import { DomainError } from '../errors/DomainError'

/**
 * Estado de una sala de batalla.
 *
 * `WAITING_FOR_PLAYERS` (unico estado que produce `BattleRoom.create()`),
 * `CANCELLED` (solo alcanzable por `BattleRoom.cancel()`) y `PREPARING`
 * (HU-15.2, RF-15: se alcanza EN LA MISMA escritura que `BattleRoom.join()`
 * cuando el ultimo cupo total de la sala se ocupa). No existe ninguna
 * transicion que saque a una sala de `PREPARING` en el alcance de HU-15.2
 * (`startBattle()` pertenece a otra Historia de Usuario, fuera de este
 * alcance).
 */
export const BattleRoomStatus = {
  WaitingForPlayers: 'WAITING_FOR_PLAYERS',
  Preparing: 'PREPARING',
  Cancelled: 'CANCELLED',
} as const

export type BattleRoomStatus = (typeof BattleRoomStatus)[keyof typeof BattleRoomStatus]

const ALL_STATUSES: readonly BattleRoomStatus[] = [
  BattleRoomStatus.WaitingForPlayers,
  BattleRoomStatus.Preparing,
  BattleRoomStatus.Cancelled,
]

export const parseBattleRoomStatus = (raw: unknown): BattleRoomStatus => {
  if (typeof raw !== 'string' || !(ALL_STATUSES as readonly string[]).includes(raw)) {
    throw new DomainError(`El estado de sala "${String(raw)}" no es reconocido.`)
  }

  return raw as BattleRoomStatus
}
