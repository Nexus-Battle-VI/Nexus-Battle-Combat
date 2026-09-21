import type { RealtimeTicketStorePort } from '../../../application/ports/RealtimeTicketPort'

interface StoredTicket {
  readonly subject: string
  readonly expiresAt: number
}

/**
 * Almacen de tickets del WebSocket EN MEMORIA (ADR-020). Es suficiente y es lo
 * correcto: un ticket vive 30 segundos y Combat corre en UNA sola replica
 * (limitacion declarada de ADR-020), asi que un ticket emitido por una peticion
 * HTTP siempre lo consume el mismo proceso. Un reinicio invalida los tickets
 * en vuelo y el cliente pide otro: no se pierde estado de negocio.
 *
 * Solo guarda el HASH del ticket. `consume` lo elimina SIEMPRE: un ticket no
 * puede usarse dos veces. Los caducados se purgan al emitir, asi el mapa no
 * crece sin limite aunque nadie llegue a consumirlos.
 */
export class InMemoryRealtimeTicketStore implements RealtimeTicketStorePort {
  private readonly tickets = new Map<string, StoredTicket>()

  issue(ticketHash: string, subject: string, expiresAt: Date): void {
    this.purge(Date.now())
    this.tickets.set(ticketHash, { subject, expiresAt: expiresAt.getTime() })
  }

  consume(ticketHash: string, now: Date): string | null {
    const stored = this.tickets.get(ticketHash)

    this.tickets.delete(ticketHash)

    return stored !== undefined && stored.expiresAt > now.getTime() ? stored.subject : null
  }

  private purge(nowMs: number): void {
    for (const [hash, stored] of this.tickets) {
      if (stored.expiresAt <= nowMs) {
        this.tickets.delete(hash)
      }
    }
  }
}
