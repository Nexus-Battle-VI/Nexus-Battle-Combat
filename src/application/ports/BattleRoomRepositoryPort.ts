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

  /**
   * Salas `CANCELLED` creadas en o despues de `since` (HU-23, recuperacion de
   * apuestas): la cancelacion no persiste su propio instante, y cualquier
   * apuesta `ACTIVE` de una sala cancelada fue reservada con la sala o despues
   * -- su hold de 24 h (D11) acota la ventana por si solo. La usa
   * `ReconcileStakes` para liberar lo que quedo pendiente tras una caida.
   */
  findCancelledSince(since: Date): Promise<readonly BattleRoom[]>

  /**
   * "Mis salas activas", de la mas reciente a la mas antigua:
   * - las NO terminales (`WAITING_FOR_PLAYERS`, `PREPARING`, `IN_BATTLE`) en
   *   las que `playerId` es participante, y
   * - las que `playerId` CREO y siguen en `WAITING_FOR_PLAYERS` aunque no se
   *   haya unido (la Web crea la sala sin unir al creador salvo que apueste).
   *   Pasada la espera, un creador que no participa ya no puede leer la sala
   *   (`GetBattleRoom` exige ser participante), asi que no se le ofrece.
   *
   * Respalda "volver a mi sala" en Jugar Online: sin ella, una sala que ya no
   * esta en el listado publico (llena, preparandose o en batalla) solo se
   * recupera conociendo su id. Un jugador puede estar en varias salas a la
   * vez; no se impone ninguna restriccion aqui.
   */
  findActiveByParticipant(playerId: string): Promise<readonly BattleRoom[]>
}

/** Estados en los que una sala sigue viva para quien participa en ella. */
export const ACTIVE_ROOM_STATUSES = ['WAITING_FOR_PLAYERS', 'PREPARING', 'IN_BATTLE'] as const

export const BATTLE_ROOM_REPOSITORY = Symbol('BattleRoomRepositoryPort')
