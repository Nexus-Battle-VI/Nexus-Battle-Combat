import { randomUUID } from 'node:crypto'

import {
  tournamentRoomCreateRequestOf,
  tournamentRoomIntentOf,
} from '../../src/adapters/inbound/http/tournament-room-request'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import type { EquippedHero } from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import {
  CreateTournamentRoom,
  type CreateTournamentRoomRequest,
  type TournamentRoomMode,
} from '../../src/application/use-cases/CreateTournamentRoom'
import { StartBattle } from '../../src/application/use-cases/StartBattle'
import { StartTournamentRoom } from '../../src/application/use-cases/StartTournamentRoom'
import { tournamentTeamSize } from '../../src/domain/policies/TournamentRosterPolicy'
import { recordingPublisher, scriptedRandom } from './battle'
import { recordingBattleCommitments } from './battle-commitments'
import { equippedHeroFixture } from './equipped-hero'

export const TOURNAMENT_AT = new Date('2026-10-07T19:02:00.000Z')

export const tournamentRequest = (
  mode: TournamentRoomMode,
  encounterId = 'E1',
): CreateTournamentRoomRequest => {
  const teamSize = tournamentTeamSize(mode)
  const members = (side: string) =>
    Array.from({ length: teamSize }, (_, seat) => `${encounterId}-${side}${String(seat + 1)}`)
  return {
    operationId: `T1:${encounterId}`,
    tournamentId: 'T1',
    encounterId,
    contractVersion: 3,
    mode,
    teamSize,
    teams: [
      { teamId: `${encounterId}-A`, memberIds: members('a') },
      { teamId: `${encounterId}-B`, memberIds: members('b') },
    ],
  }
}

/** Combat y su motor son reales; Account, Inventory y RNG son dobles explicitos. */
export const tournamentHarness = (rooms: BattleRoomRepositoryPort) => {
  let now = TOURNAMENT_AT
  const clock = { now: () => now }
  const accounts = {
    getBattleProfile: jest.fn((subject: string) =>
      Promise.resolve({ subject, displayName: `Nombre ${subject}`, avatarUrl: null }),
    ),
  }
  const heroes = {
    getEquippedHero: jest.fn((playerId: string): Promise<EquippedHero | null> =>
      Promise.resolve(
        equippedHeroFixture({ playerId, heroId: `hero-${playerId}`, activeEffects: [] }),
      ),
    ),
  }
  const commitments = recordingBattleCommitments()
  const publisher = recordingPublisher()
  const createRoom = new CreateTournamentRoom(
    rooms,
    { generate: randomUUID },
    clock,
    accounts,
    heroes,
  )
  const startRoom = new StartTournamentRoom(
    rooms,
    new StartBattle(
      rooms,
      clock,
      heroes,
      scriptedRandom(Array<number>(100).fill(0)),
      publisher,
      commitments,
    ),
  )

  return {
    rooms,
    accounts,
    heroes,
    commitments,
    publisher,
    clock,
    createRoom,
    startRoom,
    setTime: (at: Date) => {
      now = at
    },
    create: (body: unknown) => {
      const request = tournamentRoomCreateRequestOf(body)
      const intent = tournamentRoomIntentOf(body, request)
      return createRoom.execute(request, intent.hash, intent.version)
    },
    start: (roomId: string, request: CreateTournamentRoomRequest) =>
      startRoom.execute(roomId, {
        operationId: `${request.operationId}:start`,
        tournamentId: request.tournamentId,
        encounterId: request.encounterId,
      }),
  }
}

export const legacyTournamentRequest = (mode: TournamentRoomMode = 'DUO', encounterId = 'E1') => {
  const request = tournamentRequest(mode, encounterId)
  return {
    operationId: request.operationId,
    tournamentId: request.tournamentId,
    encounterId: request.encounterId,
    teams: request.teams,
  }
}
