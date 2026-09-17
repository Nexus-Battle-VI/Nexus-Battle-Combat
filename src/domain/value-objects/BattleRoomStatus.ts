import { DomainError } from '../errors/DomainError'

/**
 * Estado de una sala de batalla, alcance de HU-14 (RF-14, CA-01).
 *
 * Solo `WAITING_FOR_PLAYERS` (unico estado que produce `BattleRoom.create()`)
 * y `CANCELLED` (solo alcanzable por `BattleRoom.cancel()`). `PREPARING`
 * (RF-15) pertenece a HU-15 y NO se modela aqui — HU-14.1,
 * `HU-14.1-Decisiones-Tecnicas.md`, punto 10.
 */
export const BattleRoomStatus = {
  WaitingForPlayers: 'WAITING_FOR_PLAYERS',
  Cancelled: 'CANCELLED',
} as const

export type BattleRoomStatus = (typeof BattleRoomStatus)[keyof typeof BattleRoomStatus]

const ALL_STATUSES: readonly BattleRoomStatus[] = [
  BattleRoomStatus.WaitingForPlayers,
  BattleRoomStatus.Cancelled,
]

export const parseBattleRoomStatus = (raw: unknown): BattleRoomStatus => {
  if (typeof raw !== 'string' || !(ALL_STATUSES as readonly string[]).includes(raw)) {
    throw new DomainError(`El estado de sala "${String(raw)}" no es reconocido.`)
  }

  return raw as BattleRoomStatus
}
