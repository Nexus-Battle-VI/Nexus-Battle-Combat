import type { BattleRoom } from '../../domain/entities/BattleRoom'

export interface ParticipantDto {
  readonly kind: string
  readonly playerId: string | null
  readonly heroId: string | null
  /** Snapshot resuelto de Account al unirse (HU-15.2, DP-2). `null` para `AI`
   * y para `HUMAN` incorporados antes de esta version. */
  readonly displayName: string | null
  readonly joinedAt: string
}

export interface TeamDto {
  readonly label: string
  readonly capacity: number
  readonly participants: readonly ParticipantDto[]
}

/**
 * Vista de una sala de batalla tal como la devuelve la API (HU-14.1,
 * `HU-14.1-Contrato-Creacion-Sala.md`, seccion 1 "Response de exito").
 */
export interface BattleRoomDto {
  readonly id: string
  readonly mode: string
  readonly status: string
  readonly teams: readonly [TeamDto, TeamDto]
  readonly reward: { readonly amount: number }
  readonly createdBy: string
  readonly createdAt: string
  readonly version: number
}

export const toBattleRoomDto = (room: BattleRoom): BattleRoomDto => {
  const snapshot = room.toSnapshot()

  return {
    id: snapshot.id,
    mode: snapshot.mode,
    status: snapshot.status,
    teams: [toTeamDto(snapshot.teams[0]), toTeamDto(snapshot.teams[1])],
    reward: { amount: snapshot.reward.amount },
    createdBy: snapshot.createdBy,
    createdAt: snapshot.createdAt.toISOString(),
    version: snapshot.version,
  }
}

const toTeamDto = (team: {
  readonly label: string
  readonly capacity: number
  readonly participants: readonly {
    readonly kind: string
    readonly playerId?: string | null
    readonly heroId?: string | null
    readonly displayName?: string | null
    readonly joinedAt?: Date
  }[]
}): TeamDto => ({
  label: team.label,
  capacity: team.capacity,
  participants: team.participants.map((participant) => ({
    kind: participant.kind,
    playerId: participant.playerId ?? null,
    heroId: participant.heroId ?? null,
    displayName: participant.displayName ?? null,
    joinedAt: (participant.joinedAt ?? new Date(0)).toISOString(),
  })),
})
