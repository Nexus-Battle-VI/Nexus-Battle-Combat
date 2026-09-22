/**
 * Errores del chat que dependen del ESTADO de una sala o de comandos previos
 * (HU-13, RF-13): el dominio no puede decidirlos solo. Las reglas de forma,
 * texto y frecuencia viven en `domain/errors/ChatErrors.ts`.
 *
 * `RoomNotFoundError` (sala inexistente) se reutiliza de
 * `application/errors/ApplicationError.ts`.
 */

/** Quien pide acceso al chat de una sala no es participante HUMANO de ella. */
export class NotARoomParticipantError extends Error {
  constructor(roomId: string) {
    super(`El jugador no es participante de la sala "${roomId}".`)
    this.name = 'NotARoomParticipantError'
  }
}

/** La sala existe pero su chat esta cerrado (p. ej. cancelada). */
export class ChatRoomNotActiveError extends Error {
  constructor(roomId: string, status: string) {
    super(`El chat de la sala "${roomId}" esta cerrado: la sala esta en ${status}.`)
    this.name = 'ChatRoomNotActiveError'
  }
}

/**
 * El `commandId` ya se uso para un mensaje de OTRO canal. Repetir un
 * `commandId` devuelve el resultado ya calculado (ADR-020); devolver el de un
 * canal distinto haria creer al cliente que su mensaje llego donde no llego.
 */
export class ChatCommandIdReusedError extends Error {
  constructor() {
    super('El commandId ya se uso para un mensaje de otro canal.')
    this.name = 'ChatCommandIdReusedError'
  }
}
