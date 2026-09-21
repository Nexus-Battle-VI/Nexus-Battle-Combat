import type { BattleRoom } from '../entities/BattleRoom'
import { ParticipantKind, type Participant } from '../entities/Participant'
import { BattleRoomStatus } from '../value-objects/BattleRoomStatus'

/**
 * Quien puede leer y escribir en el chat de una sala (HU-13, RF-13).
 *
 * RF-13: «Los mensajes enviados dentro de una sala activa deben distribuirse a
 * los participantes de esa sala» y «un mensaje originado dentro de una sala de
 * batalla no debe distribuirse a jugadores pertenecientes a otra sala». De ahi:
 *
 * - solo un participante HUMANO de la sala accede a su chat (la IA no chatea);
 * - solo mientras la sala esta ACTIVA.
 *
 * «Activa» se decide con una tabla EXHAUSTIVA por estado (`Record`), no con
 * «distinto de CANCELLED»: cuando HU-17 anada `IN_BATTLE` o HU-21 anada un
 * estado final, el compilador obliga a decidir aqui si su chat esta abierto.
 * Una lista de excepciones cerraria o abriria el chat en silencio.
 */
const ROOM_CHAT_OPEN: Readonly<Record<BattleRoomStatus, boolean>> = {
  [BattleRoomStatus.WaitingForPlayers]: true,
  [BattleRoomStatus.Preparing]: true,
  [BattleRoomStatus.Cancelled]: false,
}

export const isRoomChatOpen = (status: BattleRoomStatus): boolean => ROOM_CHAT_OPEN[status]

/** Participante HUMANO de la sala con ese `playerId`, o `null` si no lo es. */
export const findHumanParticipant = (room: BattleRoom, playerId: string): Participant | null => {
  for (const team of room.teams) {
    for (const participant of team.participants) {
      if (participant.kind === ParticipantKind.Human && participant.playerId === playerId) {
        return participant
      }
    }
  }

  return null
}
