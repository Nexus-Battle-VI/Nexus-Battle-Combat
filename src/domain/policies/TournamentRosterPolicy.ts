import { InvalidTournamentRosterError } from '../errors/BattleRoomErrors'

export type TournamentRoomMode = 'SOLO' | 'DUO' | 'TRIO'

const SIZES: Readonly<Record<TournamentRoomMode, number>> = { SOLO: 1, DUO: 2, TRIO: 3 }

export const tournamentTeamSize = (mode: TournamentRoomMode = 'DUO'): number => {
  if (!Object.hasOwn(SIZES, mode)) {
    throw new InvalidTournamentRosterError('La modalidad de torneo no es valida.')
  }

  return SIZES[mode]
}

/** La misma invariante antes de consultar upstream y al construir el agregado. */
export const assertTournamentRoster = (
  teams: readonly { readonly teamId: string; readonly memberIds: readonly string[] }[],
  mode: TournamentRoomMode = 'DUO',
  teamSize: number = tournamentTeamSize(mode),
): void => {
  const expected = tournamentTeamSize(mode)
  if (teams.length !== 2 || teamSize !== expected) {
    throw new InvalidTournamentRosterError('Se requieren dos equipos del tamano de la modalidad.')
  }

  const teamIds = new Set<string>()
  const playerIds = new Set<string>()
  for (const team of teams) {
    if (typeof team.teamId !== 'string' || team.teamId.trim().length === 0) {
      throw new InvalidTournamentRosterError('Cada equipo necesita un identificador.')
    }
    if (teamIds.has(team.teamId.trim())) {
      throw new InvalidTournamentRosterError('Los dos equipos necesitan ids distintos.')
    }
    teamIds.add(team.teamId.trim())
    if (team.memberIds.length !== expected) {
      throw new InvalidTournamentRosterError(
        `Cada equipo ${mode} necesita exactamente ${String(expected)} jugadores humanos.`,
      )
    }
    for (const playerId of team.memberIds) {
      if (typeof playerId !== 'string' || playerId.trim().length === 0) {
        throw new InvalidTournamentRosterError('Cada integrante necesita un identificador humano.')
      }
      if (playerIds.has(playerId.trim())) {
        throw new InvalidTournamentRosterError('Un humano no puede ocupar dos asientos.')
      }
      playerIds.add(playerId.trim())
    }
  }
}
