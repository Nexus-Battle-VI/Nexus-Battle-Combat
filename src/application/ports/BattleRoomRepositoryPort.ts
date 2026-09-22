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

  /**
   * Salas `FINISHED` cuyo resultado se persistio en o despues de `since`
   * (HU-22, reconciliacion de `RewardWorkflow`): `since` acota la ventana, no
   * es un escaneo del historico completo. La usa
   * `ReconcileRewardWorkflows` al arrancar para cerrar el hueco entre "sala
   * FINISHED persistida" y "RewardWorkflow persistido" -- ver
   * `RewardWorkflowResultPublisher`, que crea el workflow *despues* de la
   * escritura de la sala y sin esperarla (`publish()` no puede ser sincrono:
   * su firma es la de `BattleResultPublisherPort`, ya cerrada por HU-21).
   */
  findFinishedSince(since: Date): Promise<readonly BattleRoom[]>
}

export const BATTLE_ROOM_REPOSITORY = Symbol('BattleRoomRepositoryPort')
