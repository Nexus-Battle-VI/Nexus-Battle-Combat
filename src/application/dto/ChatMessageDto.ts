import type { ChatMessage } from '../../domain/entities/ChatMessage'
import { ChatChannelKind } from '../../domain/value-objects/ChatChannel'

/**
 * Forma de un mensaje de chat en el cable (`chat.message` y `chat.history`).
 *
 * Minimizacion de datos: NO incluye el `sub` del remitente (`senderId`). Un
 * jugador del lobby que no comparte sala con otro no tiene por que conocer su
 * identificador de cuenta; el nombre visible basta para leer la conversacion.
 * Incluye `commandId` (un UUID que genero el propio cliente) para que el
 * remitente reconcilie su mensaje optimista y para poder serializar UNA sola
 * vez el mismo cuerpo para todos los destinatarios.
 */
export interface ChatMessageDto {
  readonly messageId: string
  readonly channel: 'lobby' | 'room'
  /** Solo en mensajes de sala. */
  readonly roomId?: string
  readonly seq: number
  readonly commandId: string
  readonly sender: { readonly displayName: string }
  readonly text: string
  readonly sentAt: string
}

export const toChatMessageDto = (message: ChatMessage): ChatMessageDto => ({
  messageId: message.id,
  channel: message.channel.kind === ChatChannelKind.Lobby ? 'lobby' : 'room',
  ...(message.channel.kind === ChatChannelKind.Room ? { roomId: message.channel.roomId } : {}),
  seq: message.seq,
  commandId: message.commandId,
  sender: { displayName: message.senderDisplayName },
  text: message.text,
  sentAt: message.sentAt.toISOString(),
})
