import {
  tournamentRoomCreateRequestOf,
  tournamentRoomIntentOf,
} from '../../src/adapters/inbound/http/tournament-room-request'
import { canonicalBodyHash } from '../../src/adapters/outbound/identity/internal-signature'
import {
  InvalidTournamentRoomRequestError,
  TournamentRoomOperationReusedError,
} from '../../src/application/errors/TournamentRoomErrors'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import {
  legacyTournamentRequest,
  tournamentHarness,
  tournamentRequest,
} from '../fixtures/tournament-cardinality'
import type { TournamentRoomTeamRequest } from '../../src/application/use-cases/CreateTournamentRoom'

describe('contrato y huella de intencion de salas de torneo', () => {
  const legacy = () => legacyTournamentRequest()

  it('mantiene el hash del cuerpo completo historico y replay sin campos nuevos', async () => {
    const body = { ...legacy(), historicalExtension: 'conservar-en-el-hash' }
    const parsed = tournamentRoomCreateRequestOf(body)
    const intent = tournamentRoomIntentOf(body, parsed)
    expect(intent).toEqual({ hash: canonicalBodyHash(body), version: 1 })
    expect(intent.hash).not.toBe(canonicalBodyHash(parsed))
    const h = tournamentHarness(new InMemoryBattleRoomRepository())
    const created = await h.createRoom.execute(parsed, intent.hash)
    const stored = await h.rooms.findById(created.id)
    expect(stored?.tournament).toEqual({
      operationId: body.operationId,
      tournamentId: body.tournamentId,
      encounterId: body.encounterId,
      requestHash: intent.hash,
    })
    expect(created.tournament).toBeUndefined()
    expect(await h.createRoom.execute(parsed, intent.hash)).toEqual(created)
  })

  it('no interpreta seis humanos sin modalidad como DUO', async () => {
    const body = legacyTournamentRequest('TRIO')
    const h = tournamentHarness(new InMemoryBattleRoomRepository())
    await expect(h.create(body)).rejects.toThrow('exactamente 2')
    expect(h.heroes.getEquippedHero).not.toHaveBeenCalled()
  })

  it('normaliza IDs v3 manteniendo el orden de lados y asientos', async () => {
    const request = tournamentRequest('TRIO')
    const h = tournamentHarness(new InMemoryBattleRoomRepository())
    const first = await h.create(request)
    const padTeam = (team: TournamentRoomTeamRequest) => ({
      teamId: ` ${team.teamId} `,
      memberIds: team.memberIds.map((id) => ` ${id} `),
    })
    const spaced = {
      ...request,
      operationId: ` ${request.operationId} `,
      teams: [padTeam(request.teams[0]), padTeam(request.teams[1])] as const,
    }
    expect((await h.create(spaced)).id).toBe(first.id)
    const changed = {
      ...request,
      teams: [
        { ...request.teams[0], memberIds: [...request.teams[0].memberIds].reverse() },
        request.teams[1],
      ] as const,
    }
    await expect(h.create(changed)).rejects.toBeInstanceOf(TournamentRoomOperationReusedError)
    await expect(h.create(tournamentRequest('SOLO'))).rejects.toBeInstanceOf(
      TournamentRoomOperationReusedError,
    )
    expect(h.accounts.getBattleProfile).toHaveBeenCalledTimes(6)
  })

  it.each([
    { mode: 'PVP' },
    { contractVersion: 2 },
    { teamSize: '3' },
    { teamSize: 2.5 },
    { winnerTeamId: 'E1-A' },
    { roomId: 'elegida-por-cliente' },
    {
      teams: [
        { teamId: 'A', memberIds: [{ kind: 'AI' }] },
        { teamId: 'B', memberIds: ['b'] },
      ],
    },
    {
      teams: [
        { teamId: 'A', memberIds: [null] },
        { teamId: 'B', memberIds: ['b'] },
      ],
    },
    {
      teams: [
        { teamId: 'A', memberIds: [' '] },
        { teamId: 'B', memberIds: ['b'] },
      ],
    },
    {
      teams: [
        { teamId: 'A', memberIds: ['a'], heroId: 'forjado' },
        { teamId: 'B', memberIds: ['b'] },
      ],
    },
  ])('rechaza formato o campos no autoritativos: %j', (override) => {
    expect(() =>
      tournamentRoomCreateRequestOf({ ...tournamentRequest('TRIO'), ...override }),
    ).toThrow(InvalidTournamentRoomRequestError)
  })

  it('exige mode/teamSize juntos en solicitudes nuevas', () => {
    expect(() => tournamentRoomCreateRequestOf({ ...legacy(), mode: 'TRIO' })).toThrow(
      InvalidTournamentRoomRequestError,
    )
  })

  it.each(['SOLO', 'DUO', 'TRIO'] as const)(
    '%s canonico sin marcador de version y el borrador con 3 comparten intencion',
    async (mode) => {
      const request = tournamentRequest(mode)
      const body = {
        operationId: request.operationId,
        tournamentId: request.tournamentId,
        encounterId: request.encounterId,
        mode: request.mode,
        teamSize: request.teamSize,
        teams: request.teams,
      }
      const h = tournamentHarness(new InMemoryBattleRoomRepository())
      const created = await h.create(body)
      expect(created.tournament).toEqual({ contractVersion: 3, mode, teamSize: request.teamSize })
      expect((await h.create(request)).id).toBe(created.id)
      expect(h.accounts.getBattleProfile).toHaveBeenCalledTimes(
        request.teams.flatMap((team) => team.memberIds).length,
      )
    },
  )
})
