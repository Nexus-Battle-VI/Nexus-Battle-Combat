import type { Team } from '../../domain/entities/Team'
import { toBattleEventWire } from '../dto/BattleEventDto'
import type { TournamentRoomRecordDto, TournamentRoomTeamDto } from '../dto/TournamentRoomRecordDto'
import { RoomNotFoundError } from '../errors/ApplicationError'
import { NotATournamentRoomError } from '../errors/TournamentRoomErrors'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'

/** Tope de la pagina (Management#517, contrato de `GET .../record`). */
export const MAX_TOURNAMENT_RECORD_PAGE_SIZE = 100

/**
 * Lee, paginada, el registro de eventos de una sala de torneo (Management#517).
 *
 * LECTURA PURA: reutiliza el ALMACENAMIENTO que Combat ya tiene para sus
 * eventos de batalla -- `BattleRoom.events` (HU-17, el MISMO arreglo que
 * `BattleRoomRealtimeGateway`/`ResumeBattle` sirven por WebSocket) -- y el
 * MISMO formato de cable (`toBattleEventWire`, `BattleEventDto.ts`). No
 * reescribe ni recalcula nada; solo recorta `eventsAfter(afterSeq)` a lo
 * sumo `MAX_TOURNAMENT_RECORD_PAGE_SIZE`.
 *
 * Funciona en CUALQUIER estado de la sala, incluida `FINISHED`: a diferencia
 * de `GetBattleRoom` (que exige ser participante HUMAN con testimonio JWT),
 * esta ruta es interna HMAC para el servicio Tournament, sin ese concepto de
 * "participante verificado".
 */
export class GetTournamentRoomRecord {
  constructor(private readonly rooms: BattleRoomRepositoryPort) {}

  async execute(roomId: string, afterSeq: number): Promise<TournamentRoomRecordDto> {
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    if (room.tournament === null) {
      throw new NotATournamentRoomError(roomId)
    }

    const page = room
      .eventsAfter(afterSeq)
      .slice(0, MAX_TOURNAMENT_RECORD_PAGE_SIZE)
      .map((event) => toBattleEventWire(room.id, event))

    return {
      roomId: room.id,
      tournamentId: room.tournament.tournamentId,
      encounterId: room.tournament.encounterId,
      status: room.status,
      startedAt: room.battle === null ? null : room.battle.startedAt.toISOString(),
      result: room.result,
      ...(room.tournament.mode === undefined
        ? {}
        : {
            tournament: {
              contractVersion: 3 as const,
              mode: room.tournament.mode,
              teamSize: room.teams[0].capacity,
            },
          }),
      teams: [toTeamDto(room.teams[0]), toTeamDto(room.teams[1])],
      events: { afterSeq, lastSeq: room.lastSeq, items: page },
    }
  }
}

const toTeamDto = (team: Team): TournamentRoomTeamDto => ({
  teamId: team.label,
  participants: team.participants.map((participant) => ({
    kind: participant.kind,
    playerId: participant.playerId,
    heroId: participant.heroId,
    displayName: participant.displayName,
  })),
})
