import type { ChatHistoryPage, ChatMessageRepositoryPort } from '../ports/ChatMessageRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { ChatChannel } from '../../domain/value-objects/ChatChannel'

/**
 * Lee el historial retenido de un canal (HU-13, RF-13), para quien se suscribe
 * o se reconecta con un `lastSeq`.
 *
 * NO autoriza: quien la invoca ya paso por `AuthorizeChatChannel`. Se separan
 * porque el gateway autoriza ANTES de tomar el cerrojo del canal y lee el
 * historial DENTRO de el.
 *
 * `limit` acota el tamano de la respuesta (decision tecnica, no de producto): el
 * ultimo `limit` mensajes retenidos; si hay mas, `truncated` lo declara en
 * lugar de callarlo.
 */
export class ReadChatHistory {
  constructor(
    private readonly messages: ChatMessageRepositoryPort,
    private readonly clock: ClockPort,
    private readonly limit: number,
  ) {}

  execute(channel: ChatChannel, afterSeq: number | null): Promise<ChatHistoryPage> {
    return this.messages.readHistory(channel, {
      afterSeq,
      limit: this.limit,
      now: this.clock.now(),
    })
  }
}
