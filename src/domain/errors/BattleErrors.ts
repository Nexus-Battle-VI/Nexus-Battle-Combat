import { DomainError } from './DomainError'

/**
 * Errores del inicio de batalla y del orden de turnos (HU-17, RF-17).
 *
 * Viven en el dominio porque el propio agregado puede determinarlos con su
 * estado; la traduccion a HTTP/WebSocket ocurre en el adaptador de entrada.
 */

/**
 * La sala no esta en `PREPARING` (ni en `IN_BATTLE`, caso idempotente que el
 * caso de uso resuelve antes de llegar aqui). 409: conflicto con el estado del
 * agregado, mismo criterio que `RoomNotJoinableError`.
 */
export class RoomNotStartableError extends DomainError {
  constructor(roomId: string, status: string) {
    super(`La sala "${roomId}" no puede iniciar una batalla porque su estado es ${status}.`)
    this.name = 'RoomNotStartableError'
  }
}

/**
 * La lista de participantes con la que se intenta iniciar no es la lista
 * definitiva de la sala (falta alguien, sobra alguien, hay duplicados o un
 * equipo esta vacio). RF-17: "ningun jugador que no pertenezca a esa lista
 * puede incorporarse a la cola inicial". 422.
 */
export class InvalidBattleRosterError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidBattleRosterError'
  }
}

/**
 * Codigo estable (`code` en el cuerpo del 422) de una composicion de equipos que
 * HU-17 no sabe ordenar.
 */
export const UNSUPPORTED_TEAM_COMPOSITION = 'UNSUPPORTED_TEAM_COMPOSITION'

/**
 * Los dos equipos no tienen el mismo numero de participantes (p. ej. 1 contra 3).
 * RF-17 exige alternar entre ambos equipos pero NO define que ocurre cuando uno
 * se agota antes: esa regla no esta ratificada formalmente, asi que HU-17 NO la
 * inventa. En lugar de fabricar una cola con una regla inventada, la batalla no
 * comienza (la sala sigue `PREPARING`, sin cola ni evento y sin consumir ni un
 * sorteo). 422 con `code`.
 */
export class UnsupportedTeamCompositionError extends DomainError {
  readonly code = UNSUPPORTED_TEAM_COMPOSITION

  constructor(readonly sizes: readonly [number, number]) {
    super(
      `Los equipos tienen distinto tamano (${String(sizes[0])} contra ${String(sizes[1])}) y el orden de ` +
        'turnos solo esta definido para equipos con el mismo numero de participantes: la batalla no puede comenzar.',
    )
    this.name = 'UnsupportedTeamCompositionError'
  }
}

/** La sala no esta `IN_BATTLE`: no hay turno que gestionar. 409. */
export class BattleNotInProgressError extends DomainError {
  constructor(roomId: string, status: string) {
    super(`La sala "${roomId}" no tiene una batalla en curso porque su estado es ${status}.`)
    this.name = 'BattleNotInProgressError'
  }
}

/**
 * Quien intenta cerrar el turno no es el participante de la posicion activa
 * (RF-17: "solo debe considerarse habilitado para actuar el participante
 * ubicado en la posicion activa de la cola"). 409.
 */
export class NotYourTurnError extends DomainError {
  constructor(roomId: string) {
    super(`No es el turno de ese participante en la batalla de la sala "${roomId}".`)
    this.name = 'NotYourTurnError'
  }
}

/** El identificador de comando (`commandId`, ADR-020) no es una cadena util. 400. */
export class InvalidCommandIdError extends DomainError {
  constructor() {
    super('El commandId debe ser una cadena no vacia de hasta 100 caracteres.')
    this.name = 'InvalidCommandIdError'
  }
}

/**
 * La fuente aleatoria centralizada no produjo un valor aceptable tras el
 * maximo de intentos del muestreo por rechazo. Probabilidad practicamente
 * nula (el rechazo maximo es inferior al 0,1 % por intento); existe para que
 * el bucle nunca sea infinito.
 */
export class RandomSelectionExhaustedError extends DomainError {
  constructor(bound: number) {
    super(`No se pudo seleccionar un valor uniforme en [0, ${String(bound)}) con la fuente HU-24.`)
    this.name = 'RandomSelectionExhaustedError'
  }
}
