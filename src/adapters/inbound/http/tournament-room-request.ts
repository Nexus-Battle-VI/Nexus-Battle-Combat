import { InvalidTournamentRoomRequestError } from '../../../application/errors/TournamentRoomErrors'
import type {
  CreateTournamentRoomRequest,
  TournamentRoomMode,
  TournamentRoomTeamRequest,
} from '../../../application/use-cases/CreateTournamentRoom'
import type { StartTournamentRoomRequest } from '../../../application/use-cases/StartTournamentRoom'

type JsonObject = Record<string, unknown>

const invalid = (field: string): never => {
  throw new InvalidTournamentRoomRequestError(`"${field}" no cumple el esquema esperado.`)
}

const objectAt = (value: unknown, field: string): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field)

  return value as JsonObject
}

const textAt = (value: unknown, field: string, maxLength = 200): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    invalid(field)
  }

  return value as string
}

/**
 * Cuerpo de `POST /internal/v1/combat/tournament-rooms` (Management#517).
 *
 * SOLO FORMATO (400): `operationId`/`tournamentId`/`encounterId` son texto no
 * vacio, `teams` son exactamente 2 objetos con `teamId` (texto) y
 * `memberIds` (arreglo de texto no vacio). La CARDINALIDAD exacta del
 * roster -- 2 equipos de 2 jugadores humanos, "nunca hasta 4" -- es una
 * REGLA DE NEGOCIO (422, `InvalidTournamentRosterError`) que decide
 * `BattleRoom.createTournamentRoom()`, no este parser: mismo criterio de
 * frontera 400/422 que el resto del servicio (`battle-room.dto.ts`:
 * `capacity` 1..3 es regla de negocio, no formato).
 */
export const tournamentRoomCreateRequestOf = (body: unknown): CreateTournamentRoomRequest => {
  const request = objectAt(body, 'body')
  const operationId = textAt(request.operationId, 'operationId', 300)
  const tournamentId = textAt(request.tournamentId, 'tournamentId', 300)
  const encounterId = textAt(request.encounterId, 'encounterId', 300)
  const mode = request.mode === undefined ? undefined : request.mode

  if (mode !== undefined && mode !== 'SOLO' && mode !== 'DUO' && mode !== 'TRIO') {
    invalid('mode')
  }

  if (!Array.isArray(request.teams) || request.teams.length !== 2) {
    invalid('teams')
  }

  const parseTeam = (raw: unknown, index: number): TournamentRoomTeamRequest => {
    const team = objectAt(raw, `teams[${String(index)}]`)
    const teamId = textAt(team.teamId, `teams[${String(index)}].teamId`, 100)

    if (!Array.isArray(team.memberIds) || team.memberIds.length === 0) {
      invalid(`teams[${String(index)}].memberIds`)
    }

    const memberIds = (team.memberIds as unknown[]).map((memberId, memberIndex) =>
      textAt(memberId, `teams[${String(index)}].memberIds[${String(memberIndex)}]`, 300),
    )

    return { teamId, memberIds }
  }

  const rawTeams = request.teams as unknown[]
  const teams: [TournamentRoomTeamRequest, TournamentRoomTeamRequest] = [
    parseTeam(rawTeams[0], 0),
    parseTeam(rawTeams[1], 1),
  ]

  return {
    operationId,
    tournamentId,
    encounterId,
    mode: mode as TournamentRoomMode | undefined,
    teams,
  }
}

/** Cuerpo de `POST /internal/v1/combat/tournament-rooms/:roomId/start` (Management#517). */
export const tournamentRoomStartRequestOf = (body: unknown): StartTournamentRoomRequest => {
  const request = objectAt(body, 'body')

  return {
    operationId: textAt(request.operationId, 'operationId', 300),
    tournamentId: textAt(request.tournamentId, 'tournamentId', 300),
    encounterId: textAt(request.encounterId, 'encounterId', 300),
  }
}

/**
 * `afterSeq` de `GET /internal/v1/combat/tournament-rooms/:roomId/record`.
 * Ausente = `0` (desde el principio del registro). Debe ser un entero no
 * negativo; cualquier otra cosa es un 400, no un "se interpreta como 0".
 */
export const tournamentRoomAfterSeqOf = (raw: string | undefined): number => {
  if (raw === undefined) {
    return 0
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== raw.trim()) {
    throw new InvalidTournamentRoomRequestError('"afterSeq" debe ser un entero no negativo.')
  }

  return parsed
}
