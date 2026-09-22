import type { BattleRoom } from '../../domain/entities/BattleRoom'

/**
 * Puerto de persistencia de salas de batalla (HU-14, RF-14).
 *
 * Un documento por sala, identificado por `BattleRoomId` (UUID v4 generado
 * por el servidor). Combat es la unica autoridad de `BattleRoom`.
 */
export interface BattleRoomRepositoryPort {
  /** `null` cuando la sala no existe. */
  findById(id: string): Promise<BattleRoom | null>

  /**
   * Salas en `WAITING_FOR_PLAYERS` (HU-14: "queda visible en el listado de
   * salas disponibles"). El caso de uso aplica `isAvailable()` sobre el
   * resultado para excluir las que ya completaron su cupo.
   */
  findWaitingForPlayers(): Promise<readonly BattleRoom[]>

  /**
   * Salas con una batalla EN CURSO (`IN_BATTLE`), con su estado persistido
   * (HU-21). Las usa la recuperacion de vencimientos al arrancar: los globales
   * y de turno son derivables del estado, asi que sobreviven a un reinicio.
   * Una sala `FINISHED` NO se devuelve: es terminal.
   */
  findInBattle(): Promise<readonly BattleRoom[]>

  /**
   * Guarda con bloqueo optimista: la escritura solo prospera si la version
   * almacenada sigue siendo `expectedVersion`. Si no, lanza
   * `RoomConflictError`. Devuelve la sala con la version nueva.
   */
  save(room: BattleRoom, expectedVersion: number): Promise<BattleRoom>
}

export const BATTLE_ROOM_REPOSITORY = Symbol('BattleRoomRepositoryPort')
