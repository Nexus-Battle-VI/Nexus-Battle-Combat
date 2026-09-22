import { ChatCommandIdReusedError } from '../errors/ChatApplicationErrors'
import type { AccountBattleProfilePort } from '../ports/AccountBattleProfilePort'
import type {
  AppendChatMessageResult,
  ChatMessageRepositoryPort,
} from '../ports/ChatMessageRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import type { AuthorizeChatChannel } from './AuthorizeChatChannel'
import type { ChatMessage } from '../../domain/entities/ChatMessage'
import { ChatRateLimitedError, InvalidChatCommandError } from '../../domain/errors/ChatErrors'
import type { ChatRateLimiter } from '../../domain/policies/ChatRateLimiter'
import { chatChannelKey, type ChatChannel } from '../../domain/value-objects/ChatChannel'
import { createChatText } from '../../domain/value-objects/ChatText'

export interface SendChatMessageSettings {
  /** Longitud maxima del texto, en puntos de codigo. */
  readonly maxMessageLength: number
  /** Cuanto se retiene un mensaje persistido. */
  readonly retentionMs: number
}

export interface SendChatMessageInput {
  /** `sub` verificado de la conexion: la unica identidad del remitente. */
  readonly subject: string
  readonly channel: ChatChannel
  /** Sin validar: es lo que llego del cliente. */
  readonly commandId: unknown
  /** Sin validar: es lo que llego del cliente. */
  readonly text: unknown
  /** Nombre visible ya resuelto de Account en esta conexion, si lo hay. */
  readonly knownDisplayName: string | null
}

export interface ReadyChatMessage {
  readonly kind: 'ready'
  readonly channel: ChatChannel
  readonly senderId: string
  readonly senderDisplayName: string
  readonly commandId: string
  readonly text: string
  /** Nombre que ESTA llamada obtuvo de Account, para que la conexion lo recuerde; `null` si no consulto. */
  readonly resolvedAccountDisplayName: string | null
}

export interface DuplicateChatMessage {
  readonly kind: 'duplicate'
  readonly message: ChatMessage
}

export type PreparedChatMessage = ReadyChatMessage | DuplicateChatMessage

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Envio de un mensaje de chat (HU-13, RF-13), en DOS fases para que el gateway
 * pueda tomar el cerrojo del canal solo alrededor de lo que exige orden:
 *
 * - `prepare`: todo lo que NO necesita orden y puede fallar barato -- forma del
 *   comando, autorizacion, texto, deduplicacion, nombre visible y frecuencia.
 *   Sin efectos en el almacen.
 * - `commit`: persiste. Es lo unico que el gateway ejecuta bajo el cerrojo del
 *   canal, para que el orden de `seq` sea el orden de difusion.
 *
 * Reglas y su origen:
 *
 * - Un mensaje se procesa UNA vez (RF-13): `commandId` + `senderId` identifican
 *   el comando (ADR-020). Repetirlo devuelve el resultado ya calculado
 *   (`duplicate`) sin crear otro mensaje y SIN gastar cupo de frecuencia: un
 *   reintento legitimo no se penaliza.
 * - Frecuencia: se comprueba DESPUES de deduplicar y de resolver el nombre, de
 *   modo que ni un reintento ni un fallo de Account consumen cupo.
 * - El nombre visible sale de la sala (snapshot) o de Account; NUNCA del
 *   cliente: quien envia no puede elegir con que nombre aparece.
 */
export class SendChatMessage {
  constructor(
    private readonly authorize: AuthorizeChatChannel,
    private readonly messages: ChatMessageRepositoryPort,
    private readonly accountProfiles: AccountBattleProfilePort,
    private readonly rateLimiter: ChatRateLimiter,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly settings: SendChatMessageSettings,
  ) {}

  async prepare(input: SendChatMessageInput): Promise<PreparedChatMessage> {
    const commandId = normalizeCommandId(input.commandId)
    const access = await this.authorize.execute(input.subject, input.channel)
    const text = createChatText(input.text, this.settings.maxMessageLength)
    const key = chatChannelKey(input.channel)

    const existing = await this.messages.findByCommand(input.subject, commandId)

    if (existing !== null) {
      assertSameChannel(existing, key)

      return { kind: 'duplicate', message: existing }
    }

    let senderDisplayName = access.participantDisplayName ?? input.knownDisplayName
    let resolvedAccountDisplayName: string | null = null

    if (senderDisplayName === null) {
      const profile = await this.accountProfiles.getBattleProfile(input.subject)

      senderDisplayName = profile.displayName
      resolvedAccountDisplayName = profile.displayName
    }

    const retryAfterMs = this.rateLimiter.tryAcquire(
      `${input.subject}|${key}`,
      this.clock.now().getTime(),
    )

    if (retryAfterMs > 0) {
      throw new ChatRateLimitedError(retryAfterMs)
    }

    return {
      kind: 'ready',
      channel: input.channel,
      senderId: input.subject,
      senderDisplayName,
      commandId,
      text,
      resolvedAccountDisplayName,
    }
  }

  async commit(prepared: ReadyChatMessage): Promise<AppendChatMessageResult> {
    const sentAt = this.clock.now()

    const result = await this.messages.append({
      id: this.ids.generate(),
      channel: prepared.channel,
      senderId: prepared.senderId,
      senderDisplayName: prepared.senderDisplayName,
      commandId: prepared.commandId,
      text: prepared.text,
      sentAt,
      expiresAt: new Date(sentAt.getTime() + this.settings.retentionMs),
    })

    // Dos comandos identicos en vuelo hacia canales distintos: el segundo en
    // llegar al almacen ve el mensaje del primero.
    if (result.duplicate) {
      assertSameChannel(result.message, chatChannelKey(prepared.channel))
    }

    return result
  }
}

const normalizeCommandId = (raw: unknown): string => {
  if (typeof raw !== 'string' || !UUID_SHAPE.test(raw)) {
    throw new InvalidChatCommandError('commandId debe ser un UUID.')
  }

  return raw.toLowerCase()
}

const assertSameChannel = (message: ChatMessage, requestedKey: string): void => {
  if (chatChannelKey(message.channel) !== requestedKey) {
    throw new ChatCommandIdReusedError()
  }
}
