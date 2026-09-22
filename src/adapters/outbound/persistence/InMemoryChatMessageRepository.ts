import type { ChatMessage } from '../../../domain/entities/ChatMessage'
import { chatChannelKey, type ChatChannel } from '../../../domain/value-objects/ChatChannel'
import type {
  AppendChatMessageResult,
  ChatHistoryPage,
  ChatHistoryQuery,
  ChatMessageDraft,
  ChatMessageRepositoryPort,
} from '../../../application/ports/ChatMessageRepositoryPort'

interface StoredEntry {
  readonly message: ChatMessage
  readonly expiresAt: Date
}

/**
 * Repositorio de chat en memoria (HU-13).
 *
 * Doble de desarrollo y de pruebas de los casos de uso, igual que
 * `InMemoryBattleRoomRepository`: respalda `PERSISTENCE_DRIVER=memory`, que
 * `loadConfig` prohibe en produccion. Reproduce las garantias del adaptador de
 * MongoDB que las pruebas de logica necesitan: `seq` contiguo por canal,
 * idempotencia por (`senderId`, `commandId`) y lectura que ignora lo expirado.
 *
 * No purga lo expirado (crece hasta reiniciar): en un doble de pruebas seria
 * complejidad sin valor, y la lectura ya lo oculta.
 */
export class InMemoryChatMessageRepository implements ChatMessageRepositoryPort {
  private readonly channels = new Map<string, StoredEntry[]>()
  private readonly lastSeq = new Map<string, number>()
  private readonly byCommand = new Map<string, ChatMessage>()

  append(draft: ChatMessageDraft): Promise<AppendChatMessageResult> {
    const commandKey = commandKeyOf(draft.senderId, draft.commandId)
    const existing = this.byCommand.get(commandKey)

    if (existing !== undefined) {
      return Promise.resolve({ message: existing, duplicate: true })
    }

    const channelKey = chatChannelKey(draft.channel)
    const seq = (this.lastSeq.get(channelKey) ?? 0) + 1

    const message: ChatMessage = {
      id: draft.id,
      channel: draft.channel,
      seq,
      senderId: draft.senderId,
      senderDisplayName: draft.senderDisplayName,
      commandId: draft.commandId,
      text: draft.text,
      sentAt: draft.sentAt,
    }

    this.lastSeq.set(channelKey, seq)
    this.byCommand.set(commandKey, message)
    this.channels.set(channelKey, [
      ...(this.channels.get(channelKey) ?? []),
      { message, expiresAt: draft.expiresAt },
    ])

    return Promise.resolve({ message, duplicate: false })
  }

  findByCommand(senderId: string, commandId: string): Promise<ChatMessage | null> {
    return Promise.resolve(this.byCommand.get(commandKeyOf(senderId, commandId)) ?? null)
  }

  readHistory(channel: ChatChannel, query: ChatHistoryQuery): Promise<ChatHistoryPage> {
    const key = chatChannelKey(channel)
    const after = query.afterSeq ?? 0

    const retained = (this.channels.get(key) ?? [])
      .filter(
        (entry) => entry.message.seq > after && entry.expiresAt.getTime() > query.now.getTime(),
      )
      .map((entry) => entry.message)

    const truncated = retained.length > query.limit

    return Promise.resolve({
      messages: truncated ? retained.slice(retained.length - query.limit) : retained,
      upTo: this.lastSeq.get(key) ?? 0,
      truncated,
    })
  }
}

const commandKeyOf = (senderId: string, commandId: string): string =>
  `${senderId}\u0000${commandId}`
