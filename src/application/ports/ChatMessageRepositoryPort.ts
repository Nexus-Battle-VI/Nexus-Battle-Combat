import type { ChatMessage } from '../../domain/entities/ChatMessage'
import type { ChatChannel } from '../../domain/value-objects/ChatChannel'

/**
 * Lo que el caso de uso decide de un mensaje ANTES de persistirlo. El `seq` lo
 * asigna el repositorio, no el caso de uso: solo el almacen puede repartirlo de
 * forma atomica y durable.
 */
export interface ChatMessageDraft {
  readonly id: string
  readonly channel: ChatChannel
  readonly senderId: string
  readonly senderDisplayName: string
  readonly commandId: string
  readonly text: string
  readonly sentAt: Date
  /** A partir de este instante el mensaje deja de leerse y el motor puede purgarlo. */
  readonly expiresAt: Date
}

export interface AppendChatMessageResult {
  readonly message: ChatMessage
  /**
   * `true` si ese (`senderId`, `commandId`) ya estaba persistido: se devuelve
   * el mensaje YA aceptado y no se crea otro (ADR-020: «repetir un commandId
   * devuelve el resultado ya calculado»).
   */
  readonly duplicate: boolean
}

export interface ChatHistoryQuery {
  /** Solo mensajes con `seq` mayor. `null`: desde el principio de lo retenido. */
  readonly afterSeq: number | null
  /** Maximo de mensajes a devolver: los MAS RECIENTES si hay mas. */
  readonly limit: number
  /** Los mensajes con `expiresAt <= now` no se devuelven aunque el motor aun no los haya purgado. */
  readonly now: Date
}

export interface ChatHistoryPage {
  /** En orden ascendente de `seq`. */
  readonly messages: readonly ChatMessage[]
  /**
   * Ultimo `seq` asignado en el canal (0 si nunca hubo mensajes). El cliente
   * que recibe esta pagina esta AL DIA hasta `upTo`: cualquier `seq` <= `upTo`
   * que no llegue no existe (expiro, o su escritura fallo tras reservar el
   * numero). Sin esta regla un hueco obligaria a pedir el historial sin fin.
   */
  readonly upTo: number
  /** Hay mensajes retenidos con `seq` mayor que `afterSeq` que NO se incluyen por `limit`. */
  readonly truncated: boolean
}

/**
 * Puerto de persistencia del chat (HU-13, RF-13). Combat es el dueno de los
 * mensajes de chat de sala y lobby (ADR-019, `data-ownership.md`).
 *
 * Persistir ANTES de difundir es una regla de ADR-020; este puerto es la mitad
 * «persistir»: un mensaje esta ACEPTADO cuando `append` resolvio.
 */
export interface ChatMessageRepositoryPort {
  /**
   * Reserva el siguiente `seq` del canal y persiste el mensaje. Idempotente por
   * (`senderId`, `commandId`).
   */
  append(draft: ChatMessageDraft): Promise<AppendChatMessageResult>

  /** Mensaje ya aceptado para ese comando, o `null`. */
  findByCommand(senderId: string, commandId: string): Promise<ChatMessage | null>

  readHistory(channel: ChatChannel, query: ChatHistoryQuery): Promise<ChatHistoryPage>
}

export const CHAT_MESSAGE_REPOSITORY = Symbol('ChatMessageRepositoryPort')
