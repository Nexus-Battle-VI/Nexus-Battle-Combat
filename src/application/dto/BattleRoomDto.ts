import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { BattleResult } from '../../domain/entities/BattleResult'
import type { BattleView } from '../../domain/entities/BattleState'
import type { ParticipantStakeInput } from '../../domain/value-objects/ParticipantStake'

/** Apuesta visible en el DTO: monto y estado, nunca el `holdOperationId`. */
export interface ParticipantStakeDto {
  readonly amount: number
  readonly status: string
}

export interface ParticipantDto {
  readonly kind: string
  readonly playerId: string | null
  readonly heroId: string | null
  /** Snapshot resuelto de Account al unirse (HU-15.2, DP-2). `null` para `AI`
   * y para `HUMAN` incorporados antes de esta version. */
  readonly displayName: string | null
  /**
   * HU-23 (contrato §10): la apuesta del PROPIO jugador que pide la sala.
   * Ausente cuando no aposto, y AUSENTE TAMBIEN para cualquier rival: el
   * monto y el estado de la apuesta de otro jugador nunca viajan al cliente.
   */
  readonly stake?: ParticipantStakeDto
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
  /** `seq` del ultimo evento de batalla (HU-17); 0 mientras no haya batalla. */
  readonly lastSeq: number
  /** Batalla en curso (HU-17); `null` mientras la sala no este `IN_BATTLE`. */
  readonly battle: BattleView | null
  /**
   * HU-21: resultado unico si la sala esta `FINISHED`; `null` en otro caso. Misma
   * visibilidad que `battle` (el `GET` autenticado ya exigia ser participante).
   */
  readonly result: BattleResult | null
  /**
   * HU-23 (contrato §10): resumen AGREGADO de lo que hay en juego -- la suma de
   * las apuestas `ACTIVE` de la sala, sin desglosar cuanto puso cada rival.
   * `0` cuando no hay ninguna.
   */
  readonly stakePool: { readonly total: number }
}

/**
 * Traduce la sala a su DTO. `viewerId` decide de QUIEN es la apuesta que se
 * expone (§10): solo la del propio jugador. `null` (sin espectador
 * identificado) no expone ninguna.
 */
export const toBattleRoomDto = (
  room: BattleRoom,
  viewerId: string | null = null,
): BattleRoomDto => {
  const snapshot = room.toSnapshot()

  return {
    id: snapshot.id,
    mode: snapshot.mode,
    status: snapshot.status,
    teams: [toTeamDto(snapshot.teams[0], viewerId), toTeamDto(snapshot.teams[1], viewerId)],
    reward: { amount: snapshot.reward.amount },
    createdBy: snapshot.createdBy,
    createdAt: snapshot.createdAt.toISOString(),
    version: snapshot.version,
    lastSeq: room.lastSeq,
    battle: room.battleView(),
    result: room.result,
    stakePool: {
      total: room
        .stakesAtRisk()
        .filter((stake) => stake.status === 'ACTIVE')
        .reduce((total, stake) => total + stake.amount, 0),
    },
  }
}

const toTeamDto = (
  team: {
    readonly label: string
    readonly capacity: number
    readonly participants: readonly {
      readonly kind: string
      readonly playerId?: string | null
      readonly heroId?: string | null
      readonly displayName?: string | null
      readonly stake?: ParticipantStakeInput
      readonly joinedAt?: Date
    }[]
  },
  viewerId: string | null,
): TeamDto => ({
  label: team.label,
  capacity: team.capacity,
  participants: team.participants.map((participant) => {
    const ownStake =
      viewerId !== null && participant.playerId === viewerId ? participant.stake : undefined

    return {
      kind: participant.kind,
      playerId: participant.playerId ?? null,
      heroId: participant.heroId ?? null,
      displayName: participant.displayName ?? null,
      ...(ownStake === undefined
        ? {}
        : { stake: { amount: ownStake.amount, status: ownStake.status ?? 'PENDING_RESERVE' } }),
      joinedAt: (participant.joinedAt ?? new Date(0)).toISOString(),
    }
  }),
})
