import { uuidV5 } from './inventory-grant-operation-id'

/**
 * Espacio de nombres FIJO del `operationId` del compromiso de batalla
 * (`POST /api/internal/v1/inventory/heroes/:heroId/battle-commitments`).
 *
 * ES DISTINTO DEL DE LAS ENTREGAS a proposito: los dos mapean ids logicos a
 * UUID v5, y compartir espacio de nombres haria que un id logico que coincida en
 * texto produjera el MISMO UUID en las dos rutas, mezclando dos ledgers que no
 * tienen nada que ver.
 *
 * NO CAMBIARLO NUNCA: es parte de la clave de idempotencia. Otro espacio de
 * nombres produce otro UUID para la misma sala y jugador, y un reintento se
 * veria como un compromiso nuevo: el heroe quedaria comprometido dos veces.
 */
export const BATTLE_COMMITMENT_NAMESPACE = '6f2a1c74-58d3-4e0b-9a17-2c8b5e4d7f31'

/**
 * `operationId` que viaja a Player-Inventory para comprometer (y liberar) el
 * heroe de un jugador en una sala.
 *
 * El id logico es estable por (`roomId`, `playerId`): la misma batalla y el mismo
 * jugador producen siempre el mismo UUID, que es lo que hace idempotente al
 * reintento y lo que permite liberar con la MISMA clave con la que se comprometio.
 * El `heroId` NO entra en la clave: si el heroe equipado cambiara entre el
 * compromiso y la liberacion --cosa que el propio bloqueo impide--, la clave
 * tiene que seguir siendo la misma o la liberacion no encontraria nada.
 */
export const toBattleCommitmentOperationId = (roomId: string, playerId: string): string =>
  uuidV5(`battle:${roomId}:player:${playerId}:commitment`, BATTLE_COMMITMENT_NAMESPACE)

// Se reexporta para que las pruebas puedan comprobar el determinismo sin duplicar
// el algoritmo con una segunda implementacion.
export { uuidV5 }
