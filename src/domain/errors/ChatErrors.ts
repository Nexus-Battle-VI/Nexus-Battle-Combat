import { DomainError } from './DomainError'

/**
 * Errores de reglas del chat de Jugar Online (HU-13, RF-13).
 *
 * Viven en el DOMINIO porque cada uno se determina solo con los datos del
 * propio comando (forma, texto, frecuencia): sin repositorio ni E/S. Los que
 * dependen del estado de una sala (no participante, sala no activa) viven en
 * `application/errors/ChatApplicationErrors.ts`, igual que `RoomNotFoundError`
 * frente a las invariantes de `BattleRoom`.
 *
 * El adaptador de tiempo real traduce cada clase a un codigo estable
 * (`command.rejected`, ADR-020: "un comando rechazado responde solo a quien lo
 * envia, con un codigo estable"). Ningun mensaje de estos errores viaja al
 * cliente: el codigo es el contrato.
 */

/** El comando no tiene la forma que el protocolo exige (campo ausente, tipo o formato invalido). */
export class InvalidChatCommandError extends DomainError {
  constructor(detail: string) {
    super(`Comando de chat invalido: ${detail}`)
    this.name = 'InvalidChatCommandError'
  }
}

/** El texto queda vacio tras recortarlo: no tiene ningun caracter visible. */
export class EmptyChatMessageError extends DomainError {
  constructor() {
    super('El mensaje no contiene ningun caracter visible.')
    this.name = 'EmptyChatMessageError'
  }
}

/** El texto supera la longitud maxima configurada, medida en puntos de codigo Unicode. */
export class ChatMessageTooLongError extends DomainError {
  readonly maxLength: number

  constructor(maxLength: number) {
    super(`El mensaje supera el maximo de ${String(maxLength)} caracteres.`)
    this.name = 'ChatMessageTooLongError'
    this.maxLength = maxLength
  }
}

/** El texto contiene caracteres de control o sustitutos sueltos, que no son texto de chat. */
export class ChatMessageInvalidCharactersError extends DomainError {
  constructor() {
    super('El mensaje contiene caracteres de control o invalidos.')
    this.name = 'ChatMessageInvalidCharactersError'
  }
}

/** El remitente supero la frecuencia permitida en este canal. */
export class ChatRateLimitedError extends DomainError {
  /** Milisegundos hasta que se libera el siguiente hueco de la ventana. Siempre >= 1. */
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super(`Demasiados mensajes. Reintente en ${String(retryAfterMs)} ms.`)
    this.name = 'ChatRateLimitedError'
    this.retryAfterMs = retryAfterMs
  }
}
