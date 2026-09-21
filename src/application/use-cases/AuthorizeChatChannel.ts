import { RoomNotFoundError } from '../errors/ApplicationError'
import { ChatRoomNotActiveError, NotARoomParticipantError } from '../errors/ChatApplicationErrors'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import { findHumanParticipant, isRoomChatOpen } from '../../domain/policies/ChatAccessPolicy'
import { ChatChannelKind, type ChatChannel } from '../../domain/value-objects/ChatChannel'

export interface ChatChannelAccess {
  /**
   * Nombre visible que el participante tiene en la sala (snapshot de cuando se
   * unio, HU-15.2). `null` en el lobby y en un participante sin snapshot (el
   * creador de una sala de HU-14 se registra sin nombre resuelto).
   */
  readonly participantDisplayName: string | null
}

/**
 * Decide si `subject` puede leer y escribir en un canal (HU-13, RF-13).
 *
 * - LOBBY: cualquier identidad verificada. La identidad ya la garantiza el
 *   gateway (solo una conexion autenticada llega aqui).
 * - ROOM: la sala existe, su chat esta abierto y `subject` es participante
 *   HUMANO. Se consulta el estado PERSISTIDO en cada llamada: quien salio o la
 *   sala cancelada pierde el acceso en el acto, sin depender de que una
 *   suscripcion vieja siga viva en memoria.
 *
 * Orden de comprobacion: existencia, estado, pertenencia (mismo criterio de
 * «estado antes que pertenencia» que `BattleRoom.join()`).
 */
export class AuthorizeChatChannel {
  constructor(private readonly rooms: BattleRoomRepositoryPort) {}

  async execute(subject: string, channel: ChatChannel): Promise<ChatChannelAccess> {
    if (channel.kind === ChatChannelKind.Lobby) {
      return { participantDisplayName: null }
    }

    const room = await this.rooms.findById(channel.roomId)

    if (room === null) {
      throw new RoomNotFoundError(channel.roomId)
    }

    if (!isRoomChatOpen(room.status)) {
      throw new ChatRoomNotActiveError(room.id, room.status)
    }

    const participant = findHumanParticipant(room, subject)

    if (participant === null) {
      throw new NotARoomParticipantError(room.id)
    }

    return { participantDisplayName: participant.displayName }
  }
}
