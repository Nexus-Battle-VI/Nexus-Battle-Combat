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
 * Quien pide no es participante de la sala (HU-17): ni el estado de la batalla
 * ni sus eventos son visibles para un tercero. 403.
 */
export class RoomAccessForbiddenError extends Error {
  constructor(roomId: string) {
    super(`No eres participante de la sala "${roomId}".`)
    this.name = 'RoomAccessForbiddenError'
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

/**
 * PO-JCE-01 define emparejamiento de nivel solo para Humano vs IA 1v1.
 * Rechazar otros formatos evita inventar promedio, maximo o jugador de referencia.
 */
export class PveTeamLevelMatchingUndefinedError extends Error {
  readonly code = 'PVE_TEAM_LEVEL_MATCHING_UNDEFINED'

  constructor() {
    super('El emparejamiento de nivel para JcE por equipos aun no esta definido.')
    this.name = 'PveTeamLevelMatchingUndefinedError'
  }
}
