import { createHash, randomBytes } from 'node:crypto'

import type { RealtimeTicketCodecPort } from '../../../application/ports/RealtimeTicketPort'

/**
 * Generacion y hash de los tickets del WebSocket (ADR-020).
 *
 * Es el UNICO uso de `node:crypto` de HU-17 y NO decide nada del juego: emite
 * un secreto de autenticacion opaco e impredecible (256 bits) y su SHA-256.
 * Los sorteos de la cola de turnos salen exclusivamente del motor HU-24; una
 * prueba estatica lo verifica.
 */
export class CryptoRealtimeTicketCodec implements RealtimeTicketCodecPort {
  generate(): string {
    return randomBytes(32).toString('base64url')
  }

  hash(ticket: string): string {
    return createHash('sha256').update(ticket).digest('hex')
  }
}
