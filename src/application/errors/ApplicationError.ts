/**
 * Errores de la capa de aplicacion para el ciclo de vida de salas de batalla
 * (HU-14, RF-14). Describen el resultado de una operacion que el DOMINIO no
 * puede determinar por si mismo -- depende de una busqueda en el repositorio
 * o de una condicion de escritura concurrente -- a diferencia de las
 * violaciones de invariantes puras, que viven en
 * `domain/errors/BattleRoomErrors.ts` (ver ese archivo para la justificacion
 * completa de la frontera).
 *
 * La traduccion a HTTP ocurre en el adaptador de entrada
 * (`battle-room.controller.ts::translate`).
 */

/** La sala solicitada no existe. 404. */
export class RoomNotFoundError extends Error {
  constructor(roomId: string) {
    super(`La sala "${roomId}" no existe.`)
    this.name = 'RoomNotFoundError'
  }
}

/**
 * Otra escritura modifico la sala entre la lectura y el guardado (bloqueo
 * optimista). 409: la peticion es correcta y puede reintentarse.
 */
export class RoomConflictError extends Error {
  constructor(roomId: string) {
    super(`La sala "${roomId}" cambio durante la operacion. Reintentelo.`)
    this.name = 'RoomConflictError'
  }
}
