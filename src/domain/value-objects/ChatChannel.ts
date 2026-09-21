import { DomainError } from '../errors/DomainError'
import { InvalidChatCommandError } from '../errors/ChatErrors'
import { BattleRoomId } from './BattleRoomId'

/**
 * Contexto de comunicacion del chat de Jugar Online (HU-13, RF-13).
 *
 * Documento oficial, seccion 7.6: «Las salas de batalla, así como la vista
 * general, deben tener un sistema de chat». Hay exactamente dos contextos:
 *
 * - `LOBBY`: la vista general de Jugar Online (el listado de salas). Un unico
 *   canal global. Que sea uno solo y no uno por modalidad es una propuesta
 *   ratificada por el PO por chat (no consta por escrito en el issue).
 * - `ROOM`: el chat de UNA sala concreta. Es el limite de aislamiento: un
 *   mensaje de una sala nunca llega a otra (RF-13).
 *
 * Es un tipo suma, no un par (`kind`, `roomId?`): un canal `LOBBY` con
 * `roomId` o un `ROOM` sin el no son representables.
 */
export const ChatChannelKind = {
  Lobby: 'LOBBY',
  Room: 'ROOM',
} as const

export type ChatChannelKind = (typeof ChatChannelKind)[keyof typeof ChatChannelKind]

export type ChatChannel =
  | { readonly kind: typeof ChatChannelKind.Lobby }
  | { readonly kind: typeof ChatChannelKind.Room; readonly roomId: string }

export const LOBBY_CHANNEL: ChatChannel = Object.freeze({ kind: ChatChannelKind.Lobby })

const LOBBY_KEY = 'lobby'
const ROOM_KEY_PREFIX = 'room:'

/**
 * Canal de una sala. El `roomId` debe ser un UUID v4 (mismo formato que
 * `BattleRoomId`) y se normaliza a minusculas: la clave del canal es la
 * identidad de aislamiento y dos grafias del mismo UUID no pueden ser dos
 * canales.
 */
export const roomChatChannel = (roomId: string): ChatChannel => ({
  kind: ChatChannelKind.Room,
  roomId: BattleRoomId.create(roomId).value.toLowerCase(),
})

/** Clave estable del canal: `lobby` o `room:<uuid>`. Es lo que se persiste y lo que indexa las suscripciones. */
export const chatChannelKey = (channel: ChatChannel): string =>
  channel.kind === ChatChannelKind.Lobby ? LOBBY_KEY : `${ROOM_KEY_PREFIX}${channel.roomId}`

/** Inversa de `chatChannelKey`, para restaurar desde persistencia. Una clave corrupta es un `DomainError`. */
export const chatChannelFromKey = (key: string): ChatChannel => {
  if (key === LOBBY_KEY) {
    return LOBBY_CHANNEL
  }

  if (key.startsWith(ROOM_KEY_PREFIX)) {
    return roomChatChannel(key.slice(ROOM_KEY_PREFIX.length))
  }

  throw new DomainError(`La clave de canal de chat "${key}" no es reconocida.`)
}

export interface ChatChannelInput {
  readonly channel?: unknown
  readonly roomId?: unknown
}

/**
 * Canal declarado en un comando del cliente: `channel: "lobby"` o
 * `channel: "room"` mas `roomId`. Estricto a proposito: un `roomId` junto a
 * `lobby` es un comando mal formado, no algo que se ignore, porque ignorarlo
 * dejaria al cliente creyendo que escribe en una sala.
 */
export const parseChatChannel = (input: ChatChannelInput): ChatChannel => {
  if (input.channel === 'lobby') {
    if (input.roomId !== undefined) {
      throw new InvalidChatCommandError('el canal "lobby" no admite roomId.')
    }

    return LOBBY_CHANNEL
  }

  if (input.channel === 'room') {
    try {
      return roomChatChannel(input.roomId as string)
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        throw new InvalidChatCommandError('el canal "room" exige un roomId UUID v4 valido.')
      }

      throw error
    }
  }

  throw new InvalidChatCommandError('el canal debe ser "lobby" o "room".')
}
