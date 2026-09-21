import type { ChatChannel } from '../value-objects/ChatChannel'

/**
 * Mensaje de chat ya ACEPTADO: persistido y con numero de secuencia (HU-13,
 * RF-13). Es un registro inmutable, no un agregado con comportamiento: una vez
 * aceptado no se edita ni se reordena.
 *
 * `senderId` (el `sub` verificado) vive SOLO en el servidor: es necesario para
 * autorizar y deduplicar, y para una moderacion futura, pero nunca viaja a los
 * demas clientes (minimizacion de datos: `application/dto/ChatMessageDto.ts`).
 *
 * `seq` es un entero creciente POR CANAL, independiente del `seq` de eventos
 * de batalla de HU-17: el chat no comparte secuencia con el documento
 * `battle-rooms` para no engordarlo ni competir por su bloqueo optimista.
 */
export interface ChatMessage {
  readonly id: string
  readonly channel: ChatChannel
  readonly seq: number
  readonly senderId: string
  readonly senderDisplayName: string
  /** Identificador generado por el cliente; con `senderId` identifica el comando para deduplicar. */
  readonly commandId: string
  readonly text: string
  readonly sentAt: Date
}
