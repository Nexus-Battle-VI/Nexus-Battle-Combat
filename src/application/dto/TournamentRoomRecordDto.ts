import type { BattleResult } from '../../domain/entities/BattleResult'
import type { BattleEventWire } from './BattleEventDto'

/** Un participante del roster FIJO de la sala, con su heroe (Management#517). */
export interface TournamentRoomParticipantDto {
  readonly kind: string
  readonly playerId: string | null
  readonly heroId: string | null
  readonly displayName: string | null
}

export interface TournamentRoomTeamDto {
  readonly teamId: string
  readonly participants: readonly TournamentRoomParticipantDto[]
}

/** Pagina del registro de eventos: hasta 100, con secuencia consecutiva desde `afterSeq + 1`. */
export interface TournamentRoomEventPageDto {
  readonly afterSeq: number
  readonly lastSeq: number
  readonly items: readonly BattleEventWire[]
}

/**
 * Respuesta de `GET /internal/v1/combat/tournament-rooms/:roomId/record`
 * (Management#517). Lectura PURA: nunca reescribe ni recalcula eventos, solo
 * los pagina sobre lo que la sala ya tiene persistido (HU-17/HU-21).
 */
export interface TournamentRoomRecordDto {
  readonly roomId: string
  readonly status: string
  readonly startedAt: string | null
  readonly result: BattleResult | null
  readonly teams: readonly [TournamentRoomTeamDto, TournamentRoomTeamDto]
  readonly events: TournamentRoomEventPageDto
}
