import { RoomNotFoundError } from '../../../application/errors/ApplicationError'
import {
  ChatCommandIdReusedError,
  ChatRoomNotActiveError,
  NotARoomParticipantError,
} from '../../../application/errors/ChatApplicationErrors'
import { AccountProfileMissingError } from '../../../application/errors/UpstreamErrors'
import { toChatMessageDto } from '../../../application/dto/ChatMessageDto'
import type { AuthorizeChatChannel } from '../../../application/use-cases/AuthorizeChatChannel'
import type { ReadChatHistory } from '../../../application/use-cases/ReadChatHistory'
import type { SendChatMessage } from '../../../application/use-cases/SendChatMessage'
import type { ChatMessage } from '../../../domain/entities/ChatMessage'
import {
  ChatMessageInvalidCharactersError,
  ChatMessageTooLongError,
  ChatRateLimitedError,
  EmptyChatMessageError,
  InvalidChatCommandError,
} from '../../../domain/errors/ChatErrors'
import {
  ChatChannelKind,
  chatChannelKey,
  parseChatChannel,
  roomChatChannel,
  type ChatChannel,
} from '../../../domain/value-objects/ChatChannel'
import { describeError } from '../../../infrastructure/observability/describe-error'
import type { Logger } from '../../../infrastructure/observability/logger'
import { ChannelLock } from './ChannelLock'
import { SOCKET_OPEN, type RealtimeSocket } from './RealtimeSocket'

/**
 * Tipos de mensaje del cliente que atiende el chat. El gateway enruta SOLO
 * estos; cualquier otro `chat.*` sigue cerrando con `4400`, como un tipo
 * desconocido.
 */
export const CHAT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'chat.subscribe',
  'chat.unsubscribe',
  'chat.send',
])

/**
 * Bytes pendientes de escribir por encima de los cuales un destinatario se
 * considera un consumidor lento y se le cierra (1 MiB). Decision TECNICA, no de
 * producto: sin ella, difundir a un cliente atascado acumula memoria sin limite
 * en el proceso, y en el lobby son muchos. Cerrarlo no pierde nada: al
 * reconectar recupera lo que le falto con `lastSeq`.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024

const CLOSE_SLOW_CONSUMER = 1013

/**
 * Codigos estables de `command.rejected` (ADR-020: «un comando rechazado
 * responde solo a quien lo envia, con un codigo estable»). Son el contrato: los
 * mensajes de los errores no viajan al cliente.
 */
export const ChatRejectionCode = {
  InvalidCommand: 'INVALID_COMMAND',
  EmptyMessage: 'EMPTY_MESSAGE',
  MessageTooLong: 'MESSAGE_TOO_LONG',
  InvalidCharacters: 'INVALID_CHARACTERS',
  RateLimited: 'RATE_LIMITED',
  NotSubscribed: 'NOT_SUBSCRIBED',
  RoomNotFound: 'ROOM_NOT_FOUND',
  RoomNotActive: 'ROOM_NOT_ACTIVE',
  NotAParticipant: 'NOT_A_PARTICIPANT',
  CommandIdReused: 'COMMAND_ID_REUSED',
  AccountProfileNotFound: 'ACCOUNT_PROFILE_NOT_FOUND',
  ChatUnavailable: 'CHAT_UNAVAILABLE',
} as const

export type ChatRejectionCode = (typeof ChatRejectionCode)[keyof typeof ChatRejectionCode]

interface Rejection {
  readonly code: ChatRejectionCode
  readonly retryAfterMs?: number
  readonly maxLength?: number
}

/** `null` cuando el error no es una regla del chat: un fallo de infraestructura. */
const rejectionOf = (error: unknown): Rejection | null => {
  if (error instanceof InvalidChatCommandError) {
    return { code: ChatRejectionCode.InvalidCommand }
  }

  if (error instanceof EmptyChatMessageError) {
    return { code: ChatRejectionCode.EmptyMessage }
  }

  if (error instanceof ChatMessageTooLongError) {
    return { code: ChatRejectionCode.MessageTooLong, maxLength: error.maxLength }
  }

  if (error instanceof ChatMessageInvalidCharactersError) {
    return { code: ChatRejectionCode.InvalidCharacters }
  }

  if (error instanceof ChatRateLimitedError) {
    return { code: ChatRejectionCode.RateLimited, retryAfterMs: error.retryAfterMs }
  }

  if (error instanceof RoomNotFoundError) {
    return { code: ChatRejectionCode.RoomNotFound }
  }

  if (error instanceof ChatRoomNotActiveError) {
    return { code: ChatRejectionCode.RoomNotActive }
  }

  if (error instanceof NotARoomParticipantError) {
    return { code: ChatRejectionCode.NotAParticipant }
  }

  if (error instanceof ChatCommandIdReusedError) {
    return { code: ChatRejectionCode.CommandIdReused }
  }

  if (error instanceof AccountProfileMissingError) {
    return { code: ChatRejectionCode.AccountProfileNotFound }
  }

  return null
}

export interface ChatRealtimeHandlerDeps {
  readonly authorize: AuthorizeChatChannel
  readonly readHistory: ReadChatHistory
  readonly sender: SendChatMessage
  readonly logger: Logger
  readonly maxBufferedBytes?: number
}

interface ChatConnection {
  readonly subject: string
  /** Canales a los que esta conexion esta suscrita, por clave. */
  readonly channels: Map<string, ChatChannel>
  /** Nombre visible obtenido de Account en esta conexion: evita una llamada por mensaje. */
  accountDisplayName: string | null
}

/**
 * Chat de Jugar Online sobre el WebSocket de ADR-020 (HU-13, RF-13).
 *
 * Vive DENTRO del gateway existente y no como un segundo gateway: la ruta
 * `/api/v1/combat/realtime` es una sola y `@nestjs/platform-ws` enruta cada
 * conexion por ruta al primer gateway que la declara. El gateway autentica y
 * enruta; este manejador aplica el protocolo del chat.
 *
 * Protocolo (todos los mensajes son JSON; el `sub` de la conexion es la unica
 * identidad, ningun mensaje puede declarar otro jugador):
 *
 * - `chat.subscribe {channel, roomId?, lastSeq?}` -> `chat.subscribed
 *   {channel, roomId?, upTo, truncated, messages[]}`: historial retenido desde
 *   `lastSeq` (o el reciente, si falta) y, desde ese instante, los mensajes en
 *   vivo. Repetirlo es idempotente: la conexion queda suscrita UNA vez.
 * - `chat.send {channel, roomId?, commandId, text}` -> a TODOS los suscritos
 *   del canal, incluido el remitente: `chat.message`; solo al remitente:
 *   `chat.accepted {commandId, seq, messageId, duplicate}`.
 * - `chat.unsubscribe {channel, roomId?}` -> `chat.unsubscribed`.
 * - Rechazo: `command.rejected {command, commandId?, code, ...}` solo al remitente.
 * - El servidor expulsa con `chat.unsubscribed {reason}` a quien deja de tener
 *   acceso (sale de la sala o la sala se cancela).
 *
 * Garantias y como se logran:
 *
 * - Un mensaje se procesa UNA vez: deduplicacion por (`senderId`, `commandId`) en
 *   el almacen; el reintento devuelve `chat.accepted` con el mismo `seq` y NO se
 *   vuelve a difundir.
 * - Persistir ANTES de difundir (ADR-020): `chat.message` sale solo cuando el
 *   almacen acepto el mensaje. Si la persistencia falla no se difunde nada.
 * - Orden e integridad: persistencia y difusion de un canal ocurren bajo un
 *   cerrojo por canal, asi que el orden de `seq` es el orden de entrega; y la
 *   suscripcion (leer historial y registrarse) usa el mismo cerrojo, asi que no
 *   se pierde ni se duplica un mensaje que coincida con ella.
 * - Aislamiento: la clave del canal (`lobby` | `room:<uuid>`) indexa las
 *   suscripciones; difundir a un canal solo recorre SUS suscriptores. Y el
 *   acceso a una sala se comprueba contra la sala PERSISTIDA al suscribirse, al
 *   enviar y en cada actualizacion de la sala.
 * - Una conexion caida no pierde mensajes: los recupera con `lastSeq`.
 *
 * Estado en memoria del proceso: valido con UNA replica de Combat (ADR-020).
 */
export class ChatRealtimeHandler {
  private readonly connections = new Map<RealtimeSocket, ChatConnection>()
  private readonly subscribers = new Map<string, Set<RealtimeSocket>>()
  private readonly lock = new ChannelLock()
  private readonly maxBufferedBytes: number

  constructor(private readonly deps: ChatRealtimeHandlerDeps) {
    this.maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
  }

  async handle(
    client: RealtimeSocket,
    subject: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    switch (message.type) {
      case 'chat.subscribe':
        await this.subscribe(client, subject, message)
        return
      case 'chat.unsubscribe':
        this.unsubscribe(client, message)
        return
      case 'chat.send':
        await this.send(client, subject, message)
        return
      default:
        return
    }
  }

  /** La conexion se cerro: deja de recibir. No toca el almacen. */
  onDisconnect(client: RealtimeSocket): void {
    const connection = this.connections.get(client)

    if (connection === undefined) {
      return
    }

    for (const key of connection.channels.keys()) {
      this.removeSubscriber(key, client)
    }

    this.connections.delete(client)
  }

  /**
   * La sala cambio (alguien salio, se completo, se cancelo): se revalida el
   * acceso de sus suscriptores contra el estado persistido y se expulsa a quien
   * ya no lo tiene. Es lo que impide que quien abandona una sala siga leyendo su
   * chat con una suscripcion vieja.
   *
   * Un fallo de infraestructura al revalidar NO expulsa: no poder comprobar no
   * es lo mismo que no tener acceso, y el envio vuelve a comprobarlo.
   */
  async onRoomUpdated(roomId: string): Promise<void> {
    let channel: ChatChannel

    try {
      channel = roomChatChannel(roomId)
    } catch {
      return
    }

    const key = chatChannelKey(channel)

    if (!this.subscribers.has(key)) {
      return
    }

    await this.lock.run(key, async () => {
      for (const client of [...(this.subscribers.get(key) ?? [])]) {
        const connection = this.connections.get(client)

        if (connection === undefined) {
          continue
        }

        try {
          await this.deps.authorize.execute(connection.subject, channel)
        } catch (error: unknown) {
          const rejection = rejectionOf(error)

          if (rejection === null) {
            this.deps.logger.error('chat_revalidacion_fallo', {
              channel: key,
              reason: describeError(error),
            })
            continue
          }

          this.removeSubscriber(key, client)
          connection.channels.delete(key)
          this.sendFrame(client, {
            type: 'chat.unsubscribed',
            ...channelWire(channel),
            reason: rejection.code,
          })
        }
      }
    })
  }

  /** Suscriptores vivos de un canal (`lobby` | `room:<uuid>`). Para pruebas y diagnostico. */
  subscriberCount(channelKeyValue: string): number {
    return this.subscribers.get(channelKeyValue)?.size ?? 0
  }

  private async subscribe(
    client: RealtimeSocket,
    subject: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    let channel: ChatChannel
    let afterSeq: number | null

    try {
      channel = parseChatChannel(message)
      afterSeq = parseLastSeq(message.lastSeq)
      await this.deps.authorize.execute(subject, channel)
    } catch (error: unknown) {
      this.reject(client, 'chat.subscribe', error, undefined)
      return
    }

    const key = chatChannelKey(channel)

    try {
      await this.lock.run(key, async () => {
        if (client.readyState !== SOCKET_OPEN) {
          return
        }

        // Ya bajo el cerrojo: si la sala cambio entre la primera comprobacion y
        // aqui (p. ej. el jugador salio), no se registra a un no participante.
        await this.deps.authorize.execute(subject, channel)

        const page = await this.deps.readHistory.execute(channel, afterSeq)

        this.addSubscriber(client, subject, key, channel)
        this.sendFrame(client, {
          type: 'chat.subscribed',
          ...channelWire(channel),
          upTo: page.upTo,
          truncated: page.truncated,
          messages: page.messages.map(toChatMessageDto),
        })
      })
    } catch (error: unknown) {
      this.reject(client, 'chat.subscribe', error, undefined)
    }
  }

  private unsubscribe(client: RealtimeSocket, message: Record<string, unknown>): void {
    let channel: ChatChannel

    try {
      channel = parseChatChannel(message)
    } catch (error: unknown) {
      this.reject(client, 'chat.unsubscribe', error, undefined)
      return
    }

    const key = chatChannelKey(channel)

    this.removeSubscriber(key, client)
    this.connections.get(client)?.channels.delete(key)
    this.sendFrame(client, {
      type: 'chat.unsubscribed',
      ...channelWire(channel),
      reason: 'REQUESTED',
    })
  }

  private async send(
    client: RealtimeSocket,
    subject: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    // Se devuelve en los rechazos para que el cliente sepa a que comando responden.
    const commandId = typeof message.commandId === 'string' ? message.commandId : undefined

    let channel: ChatChannel

    try {
      channel = parseChatChannel(message)
    } catch (error: unknown) {
      this.reject(client, 'chat.send', error, commandId)
      return
    }

    const key = chatChannelKey(channel)
    const connection = this.connections.get(client)

    // Se escribe en el canal que se ve: una conexion no publica en un contexto
    // al que no esta suscrita.
    if (!connection?.channels.has(key)) {
      this.sendFrame(client, {
        type: 'command.rejected',
        command: 'chat.send',
        ...(commandId === undefined ? {} : { commandId }),
        code: ChatRejectionCode.NotSubscribed,
      })
      return
    }

    try {
      const prepared = await this.deps.sender.prepare({
        subject,
        channel,
        commandId: message.commandId,
        text: message.text,
        knownDisplayName: connection.accountDisplayName,
      })

      if (prepared.kind === 'duplicate') {
        this.accept(client, prepared.message, true)
        return
      }

      if (prepared.resolvedAccountDisplayName !== null) {
        connection.accountDisplayName = prepared.resolvedAccountDisplayName
      }

      await this.lock.run(key, async () => {
        const result = await this.deps.sender.commit(prepared)

        // Solo un mensaje NUEVO se difunde. Un duplicado que coincidio en el
        // almacen con otro en vuelo ya fue difundido por quien lo acepto.
        if (!result.duplicate) {
          this.broadcast(key, result.message)
        }

        this.accept(client, result.message, result.duplicate)
      })
    } catch (error: unknown) {
      this.reject(client, 'chat.send', error, commandId)
    }
  }

  private broadcast(key: string, message: ChatMessage): void {
    const subscribers = this.subscribers.get(key)

    if (subscribers === undefined) {
      return
    }

    // Se serializa UNA vez: el cuerpo es identico para todos los destinatarios.
    const payload = JSON.stringify({ type: 'chat.message', ...toChatMessageDto(message) })

    for (const client of subscribers) {
      this.deliver(client, payload)
    }
  }

  private deliver(client: RealtimeSocket, payload: string): void {
    if (client.readyState !== SOCKET_OPEN) {
      return
    }

    if ((client.bufferedAmount ?? 0) > this.maxBufferedBytes) {
      this.deps.logger.warn('chat_consumidor_lento', { bufferedAmount: client.bufferedAmount ?? 0 })
      client.close(CLOSE_SLOW_CONSUMER, 'consumidor_lento')
      return
    }

    // Un socket que falla no debe impedir que el resto reciba el mensaje.
    try {
      client.send(payload)
    } catch (error: unknown) {
      this.deps.logger.warn('chat_envio_fallo', { reason: describeError(error) })
    }
  }

  private accept(client: RealtimeSocket, message: ChatMessage, duplicate: boolean): void {
    this.sendFrame(client, {
      type: 'chat.accepted',
      commandId: message.commandId,
      seq: message.seq,
      messageId: message.id,
      duplicate,
    })
  }

  private reject(
    client: RealtimeSocket,
    command: string,
    error: unknown,
    commandId: string | undefined,
  ): void {
    const rejection = rejectionOf(error)

    if (rejection === null) {
      // Sin el texto del mensaje: no se registra el contenido del chat.
      this.deps.logger.error('chat_fallo', { command, reason: describeError(error) })
    }

    const resolved: Rejection = rejection ?? { code: ChatRejectionCode.ChatUnavailable }

    this.sendFrame(client, {
      type: 'command.rejected',
      command,
      ...(commandId === undefined ? {} : { commandId }),
      code: resolved.code,
      ...(resolved.retryAfterMs === undefined ? {} : { retryAfterMs: resolved.retryAfterMs }),
      ...(resolved.maxLength === undefined ? {} : { maxLength: resolved.maxLength }),
    })
  }

  private addSubscriber(
    client: RealtimeSocket,
    subject: string,
    key: string,
    channel: ChatChannel,
  ): void {
    let connection = this.connections.get(client)

    if (connection === undefined) {
      connection = { subject, channels: new Map(), accountDisplayName: null }
      this.connections.set(client, connection)
    }

    connection.channels.set(key, channel)

    let set = this.subscribers.get(key)

    if (set === undefined) {
      set = new Set()
      this.subscribers.set(key, set)
    }

    set.add(client)
  }

  private removeSubscriber(key: string, client: RealtimeSocket): void {
    const set = this.subscribers.get(key)

    if (set === undefined) {
      return
    }

    set.delete(client)

    if (set.size === 0) {
      this.subscribers.delete(key)
    }
  }

  private sendFrame(client: RealtimeSocket, frame: Record<string, unknown>): void {
    if (client.readyState !== SOCKET_OPEN) {
      return
    }

    try {
      client.send(JSON.stringify(frame))
    } catch (error: unknown) {
      this.deps.logger.warn('chat_envio_fallo', { reason: describeError(error) })
    }
  }
}

const channelWire = (
  channel: ChatChannel,
): { readonly channel: 'lobby' } | { readonly channel: 'room'; readonly roomId: string } =>
  channel.kind === ChatChannelKind.Lobby
    ? { channel: 'lobby' }
    : { channel: 'room', roomId: channel.roomId }

const parseLastSeq = (raw: unknown): number | null => {
  if (raw === undefined) {
    return null
  }

  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new InvalidChatCommandError('lastSeq debe ser un entero >= 0.')
  }

  return raw
}
