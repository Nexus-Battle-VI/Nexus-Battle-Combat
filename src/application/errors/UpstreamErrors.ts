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
 * /api/internal/v1/players/:playerId/equipped-hero` respondio 404). 422: la
 * peticion de union es sintacticamente correcta, pero una precondicion de
 * negocio -- "unirse a una batalla exige un heroe equipado" -- no se cumple
 * todavia. Distinto de `UpstreamServiceError`: aqui Player-Inventory SI
 * respondio, y la respuesta es "no hay heroe", un camino de negocio valido,
 * no una falla de integracion.
 *
 * `code` (HU-16.1/HU-16.2, DP-7): estructurado y ADITIVO, siguiendo el MISMO
 * patron que `AccountProfileMissingError` de mas abajo -- antes de esta
 * ampliacion este error caia en el 422 generico sin codigo (hallazgo de la
 * auditoria HU-16.1), indistinguible en el cuerpo de la respuesta de
 * cualquier otro 422. Distinto de `PrecombatEligibilityBlockedError`
 * (HU-16): aqui el jugador NO TIENE NINGUN heroe equipado; alli SI lo tiene,
 * pero no es elegible para la sala concreta.
 */
export class PlayerWithoutEquippedHeroError extends Error {
  readonly code = 'HERO_NOT_SELECTED'

  constructor(playerId: string) {
    super(`El jugador "${playerId}" no tiene un heroe equipado.`)
    this.name = 'PlayerWithoutEquippedHeroError'
  }
}

/**
 * HU-15.4 (hallazgo de validacion integral). Account respondio 404 a
 * `GET /internal/accounts/:subject/battle-profile` para un `subject` que SI
 * paso la verificacion del testimonio de Combat -- es decir, Account no
 * tiene una cuenta asociada a ese sujeto todavia.
 *
 * Se distingue DELIBERADAMENTE de `UpstreamServiceError`: aqui Account SI
 * respondio, con una forma de respuesta valida (404, no timeout/401/5xx/
 * cuerpo invalido) -- el 404 es informacion de negocio ("no existe perfil
 * para este sujeto"), no un fallo de transporte ni de disponibilidad. Antes
 * de esta clase, `AccountHttpClient` colapsaba este caso en
 * `UpstreamServiceError` -> 503 ("El servicio de combate no esta disponible
 * en este momento"), indistinguible de una caida real de Account: quien
 * pedia unirse no podia saber si debia reintentar en segundos (503 real) o
 * si su sesion apuntaba a un sujeto sin cuenta provisionada (este caso,
 * irrecuperable con un reintento).
 *
 * 422, no 503 ni 404: la peticion de union es sintacticamente correcta, y el
 * `roomId` de la URL es del recurso "sala", no del recurso "perfil de
 * cuenta" -- devolver 404 aqui se confundiria en Web con "la sala no
 * existe" (`RoomNotFoundError`, tambien 404 en este mismo endpoint). Mismo
 * criterio de "precondicion de negocio incumplida" que
 * `PlayerWithoutEquippedHeroError`.
 */
export class AccountProfileMissingError extends Error {
  readonly subject: string

  constructor(subject: string) {
    super(`El sujeto "${subject}" no tiene una cuenta asociada en Account.`)
    this.name = 'AccountProfileMissingError'
    this.subject = subject
  }
}
