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
 * «distinto de CANCELLED»: cuando se anade un estado, el compilador obliga a
 * decidir aqui si su chat esta abierto. Una lista de excepciones cerraria o
 * abriria el chat en silencio. Ya funciono asi: al llegar `IN_BATTLE` (HU-17) la
 * compilacion fallo hasta decidirlo.
 *
 * `IN_BATTLE` queda ABIERTO: es la sala mas activa que existe, y cerrar el chat
 * al empezar la batalla dejaria sin sentido «chat en sala de batalla». Ningun
 * documento lo fija (el oficial no trata el chat de sala): es una decision
 * tecnica derivada de «sala activa», pendiente de confirmar por el PO. Cuando
 * HU-21 anada el estado de batalla terminada, decidira ahi si su chat se cierra.
 */
const ROOM_CHAT_OPEN: Readonly<Record<BattleRoomStatus, boolean>> = {
  [BattleRoomStatus.WaitingForPlayers]: true,
  [BattleRoomStatus.Preparing]: true,
  [BattleRoomStatus.InBattle]: true,
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
