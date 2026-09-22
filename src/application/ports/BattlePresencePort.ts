/**
 * Presencia de los participantes en una batalla (HU-21, contrato §4.2).
 *
 * La presencia es de la CONEXION, no del jugador: un participante esta presente
 * mientras tenga al menos una conexion de batalla abierta (varias pestanas
 * cuentan una vez). Vive en memoria (ADR-020: una sola replica) y no se
 * persiste: al arrancar, todo el mundo esta ausente.
 *
 * El puerto no conoce conexiones ni sockets: solo la marca por sala y jugador.
 */
export interface BattlePresencePort {
  /**
   * Marca al jugador como ausente desde `since`. Si ya estaba ausente,
   * CONSERVA el `since` mas antiguo: la gracia se cuenta desde la primera vez
   * que se perdio la ultima conexion, no desde el ultimo aviso.
   */
  markAbsent(roomId: string, playerId: string, since: Date): void

  /** El jugador volvio: cancela su gracia. */
  markPresent(roomId: string, playerId: string): void

  /** Ausencias vigentes de la sala: `playerId -> desde`. */
  absences(roomId: string): ReadonlyMap<string, Date>

  /** La sala termino: no quedan estructuras de presencia de esa sala. */
  clear(roomId: string): void
}

export const BATTLE_PRESENCE = Symbol('BattlePresencePort')
