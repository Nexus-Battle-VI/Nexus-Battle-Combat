/**
 * Tickets de un solo uso del WebSocket (ADR-020): el cliente los pide por HTTP
 * con su JWT y los presenta como primer mensaje del socket, de modo que el
 * testimonio nunca viaja en la URL.
 */

/** Generacion y hash del ticket. Se separa para que el caso de uso no conozca `crypto`. */
export interface RealtimeTicketCodecPort {
  /** Ticket opaco, aleatorio e impredecible (un secreto de seguridad, no un valor de juego). */
  generate(): string
  /** Hash irreversible del ticket: es lo unico que se retiene. */
  hash(ticket: string): string
}

/** Almacen efimero de tickets EMITIDOS: solo guarda el hash, ligado al `sub` y a su caducidad. */
export interface RealtimeTicketStorePort {
  issue(ticketHash: string, subject: string, expiresAt: Date): void
  /**
   * Consume el ticket: lo elimina SIEMPRE (un ticket no se puede usar dos
   * veces) y devuelve el `sub` solo si existia y no habia caducado.
   */
  consume(ticketHash: string, now: Date): string | null
}

export const REALTIME_TICKET_CODEC = Symbol('RealtimeTicketCodecPort')
export const REALTIME_TICKET_STORE = Symbol('RealtimeTicketStorePort')
