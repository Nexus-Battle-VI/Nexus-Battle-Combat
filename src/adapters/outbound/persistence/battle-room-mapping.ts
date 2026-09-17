import { Int32 } from 'mongodb'

import type { BattleRoomSnapshot } from '../../../domain/entities/BattleRoom'
import type { TeamSnapshot } from '../../../domain/entities/Team'

/**
 * Traduccion entre el documento de MongoDB y la instantanea de la sala de
 * batalla (HU-14). Pura y aparte del repositorio, igual que
 * `hero-selection-mapping.ts` de Player-Inventory: es donde se puede uno
 * equivocar de verdad, y aqui se prueba sin contenedor.
 */
export class BattleRoomMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BattleRoomMappingError'
  }
}

export interface ParticipantDocument {
  readonly kind: string
  readonly playerId: string | null
  readonly heroId: string | null
  readonly joinedAt: Date
}

export interface TeamDocument {
  readonly label: string
  readonly capacity: Int32 | number
  readonly participants: readonly ParticipantDocument[]
}

export interface RewardDocument {
  readonly amount: number
}

/**
 * `_id` es el identificador de la sala (UUID v4 generado por el servidor),
 * igual que `hero-loadouts`/`hero-selections` usan su propia clave como
 * `_id` en lugar de un `ObjectId` autogenerado.
 */
export interface BattleRoomDocument {
  readonly _id: string
  readonly mode: string
  readonly status: string
  readonly teams: readonly [TeamDocument, TeamDocument]
  readonly reward: RewardDocument
  readonly createdBy: string
  readonly createdAt: Date
  readonly version: Int32 | number
}

const toInt = (value: Int32 | number, field: string, roomId: string): number => {
  const raw = typeof value === 'number' ? value : value.valueOf()

  if (!Number.isInteger(raw) || raw < 0) {
    throw new BattleRoomMappingError(
      `El campo "${field}" de la sala "${roomId}" no es un entero no negativo: ${String(raw)}.`,
    )
  }

  return raw
}

const toTeamSnapshot = (team: TeamDocument, roomId: string): TeamSnapshot => ({
  label: team.label,
  capacity: toInt(team.capacity, `teams.capacity (${team.label})`, roomId),
  participants: team.participants.map((participant) => ({
    kind: participant.kind,
    playerId: participant.playerId,
    heroId: participant.heroId,
    joinedAt: participant.joinedAt,
  })),
})

export const toSnapshot = (document: BattleRoomDocument): BattleRoomSnapshot => {
  if (!(document.createdAt instanceof Date) || Number.isNaN(document.createdAt.getTime())) {
    throw new BattleRoomMappingError(
      `La fecha de creacion de la sala "${document._id}" no es valida.`,
    )
  }

  return {
    id: document._id,
    mode: document.mode as BattleRoomSnapshot['mode'],
    status: document.status as BattleRoomSnapshot['status'],
    teams: [
      toTeamSnapshot(document.teams[0], document._id),
      toTeamSnapshot(document.teams[1], document._id),
    ],
    reward: { amount: document.reward.amount },
    createdBy: document.createdBy,
    createdAt: document.createdAt,
    version: toInt(document.version, 'version', document._id),
  }
}

const toTeamDocument = (team: TeamSnapshot): TeamDocument => ({
  label: team.label,
  capacity: new Int32(team.capacity),
  participants: team.participants.map((participant) => ({
    kind: participant.kind,
    playerId: participant.playerId ?? null,
    heroId: participant.heroId ?? null,
    joinedAt: participant.joinedAt ?? new Date(0),
  })),
})

export const toDocument = (snapshot: BattleRoomSnapshot): BattleRoomDocument => ({
  _id: snapshot.id,
  mode: snapshot.mode,
  status: snapshot.status,
  teams: [toTeamDocument(snapshot.teams[0]), toTeamDocument(snapshot.teams[1])],
  reward: { amount: snapshot.reward.amount },
  createdBy: snapshot.createdBy,
  createdAt: snapshot.createdAt,
  version: new Int32(snapshot.version),
})
