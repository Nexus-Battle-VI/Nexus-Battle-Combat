import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { RoomNotFoundError } from '../../src/application/errors/ApplicationError'
import {
  NotATournamentRoomError,
  TournamentRoomMismatchError,
} from '../../src/application/errors/TournamentRoomErrors'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import { StartBattle } from '../../src/application/use-cases/StartBattle'
import {
  StartTournamentRoom,
  type StartTournamentRoomRequest,
} from '../../src/application/use-cases/StartTournamentRoom'
import { BattleRoom, type CreateTournamentRoomInput } from '../../src/domain/entities/BattleRoom'
import { clock, heroesPort, recordingPublisher, scriptedRandom } from '../fixtures/battle'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'

const AT = new Date('2026-10-01T12:00:00.000Z')
const ROOM_ID = '33333333-3333-4333-8333-333333333333'

const member = (playerId: string) => ({
  playerId,
  heroId: `hero-${playerId}`,
  heroLoadoutVersion: 3,
  displayName: `Nombre ${playerId}`,
})

const tournamentInput = (
  overrides: Partial<CreateTournamentRoomInput> = {},
): CreateTournamentRoomInput => ({
  operationId: 'T1:E1',
  tournamentId: 'T1',
  encounterId: 'T1:E1',
  requestHash: 'a'.repeat(64),
  teams: [
    { teamId: 'equipo1', members: [member('p1'), member('p2')] },
    { teamId: 'equipo2', members: [member('p3'), member('p4')] },
  ],
  ...overrides,
})

const seedTournamentRoom = async (
  rooms: BattleRoomRepositoryPort,
  overrides: Partial<CreateTournamentRoomInput> = {},
): Promise<BattleRoom> => {
  const room = BattleRoom.createTournamentRoom(
    ROOM_ID,
    'tournament:T1',
    tournamentInput(overrides),
    AT,
  )

  return rooms.save(room, 0)
}

const REQUEST: StartTournamentRoomRequest = {
  operationId: 'T1:E1:start',
  tournamentId: 'T1',
  encounterId: 'T1:E1',
}

const build = (
  rooms: BattleRoomRepositoryPort,
): { useCase: StartTournamentRoom; publisher: ReturnType<typeof recordingPublisher> } => {
  const publisher = recordingPublisher()
  const startBattle = new StartBattle(
    rooms,
    clock,
    heroesPort(),
    scriptedRandom([0, 0, 0, 0, 0, 0, 0, 0]),
    publisher,
    recordingBattleCommitments(),
  )

  return { useCase: new StartTournamentRoom(rooms, startBattle), publisher }
}

describe('StartTournamentRoom (Management#517)', () => {
  it('arranca la sala PREPARING reutilizando StartBattle (motor, compromisos y aleatoriedad TAL CUAL)', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await seedTournamentRoom(rooms)
    const { useCase, publisher } = build(rooms)

    const dto = await useCase.execute(ROOM_ID, REQUEST)

    expect(dto.status).toBe('IN_BATTLE')
    expect(dto.battle?.turnOrder).toHaveLength(4)
    expect(new Set(dto.battle?.turnOrder.map((entry) => entry.playerId))).toEqual(
      new Set(['p1', 'p2', 'p3', 'p4']),
    )
    expect(publisher.published).toHaveLength(1)
  })

  it('es IDEMPOTENTE: reenviarlo devuelve la MISMA sala sin un segundo battleStarted', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await seedTournamentRoom(rooms)
    const { useCase, publisher } = build(rooms)

    const first = await useCase.execute(ROOM_ID, REQUEST)
    const second = await useCase.execute(ROOM_ID, REQUEST)

    expect(second).toEqual(first)
    expect(publisher.published).toHaveLength(1)
  })

  it('es IDEMPOTENTE incluso DESPUES de FINISHED (StartBattle solo no lo cubre; esta clase si)', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await seedTournamentRoom(rooms)
    const { useCase } = build(rooms)

    await useCase.execute(ROOM_ID, REQUEST)

    const inBattle = await rooms.findById(ROOM_ID)
    const finished = inBattle?.finish({ reason: 'TIME_LIMIT' }, AT)
    if (finished === undefined) throw new Error('la sala debia existir')
    await rooms.save(finished, inBattle?.version ?? 0)

    const again = await useCase.execute(ROOM_ID, REQUEST)

    expect(again.status).toBe('FINISHED')
  })

  it('sala inexistente -> RoomNotFoundError', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const { useCase } = build(rooms)

    await expect(useCase.execute(ROOM_ID, REQUEST)).rejects.toBeInstanceOf(RoomNotFoundError)
  })

  it('una sala del lobby publico (sin tournament) -> NotATournamentRoomError', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const lobbyRoom = BattleRoom.create(
      ROOM_ID,
      'jugador-1',
      { mode: 'PVP', teamConfigs: [{ capacity: 1 }, { capacity: 1 }], reward: { amount: 0 } },
      AT,
    )
    await rooms.save(lobbyRoom, 0)
    const { useCase } = build(rooms)

    await expect(useCase.execute(ROOM_ID, REQUEST)).rejects.toBeInstanceOf(NotATournamentRoomError)
  })

  it('tournamentId/encounterId que no coinciden con la sala -> TournamentRoomMismatchError', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await seedTournamentRoom(rooms)
    const { useCase } = build(rooms)

    await expect(
      useCase.execute(ROOM_ID, { ...REQUEST, tournamentId: 'otro-torneo' }),
    ).rejects.toBeInstanceOf(TournamentRoomMismatchError)
  })
})
