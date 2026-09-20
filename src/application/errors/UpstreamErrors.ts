/**
 * Errores de la integracion cross-service de HU-15.2/RF-15: los clientes
 * HTTP internos hacia Account y Player-Inventory (`adapters/outbound/http`)
 * NUNCA dejan escapar un `Error` generico de `fetch`/`AbortController` ni un
 * codigo HTTP crudo -- lo traducen a una de estas dos clases, que
 * `battle-room.controller.ts::translate` traduce a su vez a HTTP.
 *
 * Viven en `application/errors`, no en `domain/errors`, por el mismo
 * criterio que `RoomNotFoundError`/`RoomConflictError`: dependen de una
 * llamada de red a un servicio externo, que el dominio no puede determinar
 * por si mismo.
 */

/**
 * El servicio interno (`'account'` | `'player-inventory'`) no respondio de
 * forma utilizable: no alcanzable, tiempo de espera agotado, 401 (secreto
 * interno mal configurado o rechazado), 5xx, o una forma de respuesta que no
 * coincide con el contrato esperado. 503: Combat no puede completar el
 * ingreso sin este dato, y la causa es ajena a quien pide unirse.
 *
 * NO TRANSPORTA EL CUERPO DE LA RESPUESTA NI CABECERAS: podria contener
 * detalles internos del otro servicio. `reason` es una etiqueta corta y
 * estable (`'timeout'`, `'no_alcanzable'`, `'no_autorizado'`,
 * `'respuesta_invalida'`, `'error_servidor'`), pensada para registro
 * estructurado, no para mostrarse tal cual a quien hizo la peticion.
 */
export class UpstreamServiceError extends Error {
  readonly service: string
  readonly reason: string

  constructor(service: string, reason: string) {
    super(`El servicio interno "${service}" no respondio (${reason}).`)
    this.name = 'UpstreamServiceError'
    this.service = service
    this.reason = reason
  }
}

/**
 * HU-15.2 (RF-15, DP-4). El jugador autenticado no tiene ningun heroe
 * equipado en Player-Inventory (`GET
 * /internal/v1/players/:playerId/equipped-hero` respondio 404). 422: la
 * peticion de union es sintacticamente correcta, pero una precondicion de
 * negocio -- "unirse a una batalla exige un heroe equipado" -- no se cumple
 * todavia. Distinto de `UpstreamServiceError`: aqui Player-Inventory SI
 * respondio, y la respuesta es "no hay heroe", un camino de negocio valido,
 * no una falla de integracion.
 */
export class PlayerWithoutEquippedHeroError extends Error {
  constructor(playerId: string) {
    super(`El jugador "${playerId}" no tiene un heroe equipado.`)
    this.name = 'PlayerWithoutEquippedHeroError'
  }
}
