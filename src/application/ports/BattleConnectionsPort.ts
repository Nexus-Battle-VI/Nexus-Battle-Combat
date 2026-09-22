/**
 * Consulta de conexiones de batalla (HU-21). Es de SOLO LECTURA: `StartBattle`
 * la usa para saber quien no tiene conexion al iniciar la batalla y sembrar su
 * gracia desde `startedAt` (contrato §4.2).
 *
 * La implementa el gateway, que ya conoce sus conexiones; el gateway no depende
 * de `StartBattle`, asi que no hay ciclo de inyeccion.
 */
export interface BattleConnectionsPort {
  /** `true` si esa sala tiene una conexion autenticada de ese jugador. */
  isConnected(roomId: string, playerId: string): boolean
}

export const BATTLE_CONNECTIONS = Symbol('BattleConnectionsPort')
