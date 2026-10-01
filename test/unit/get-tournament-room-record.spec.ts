import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { RoomNotFoundError } from '../../src/application/errors/ApplicationError'
import { NotATournamentRoomError } from '../../src/application/errors/TournamentRoomErrors'
import {
  GetTournamentRoomRecord,
  MAX_TOURNAMENT_RECORD_PAGE_SIZE,
} from '../../src/application/use-cases/GetTournamentRoomRecord'
import { StartBattle } from '../../src/application/use-cases/StartBattle'
import { StartTournamentRoom } from '../../src/application/use-cases/StartTournamentRoom'
import { BattleRoom, type CreateTournamentRoomInput } from '../../src/domain/entities/BattleRoom'
import type { BattleEvent } from '../../src/domain/entities/BattleEvent'
import { clock, heroesPort, recordingPublisher, scriptedRandom } from '../fixtures/battle'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'

const AT = new Date('2026-10-01T12:00:00.000Z')
const ROOM_ID = '44444444-4444-4444-8444-444444444444'

const member = (playerId: string) => ({
  playerId,
  heroId: `hero-${playerId}`,
  heroLoadoutVersion: 3,
  displayName: `Nombre ${playerId}`,
})

const tournamentInput: CreateTournamentRoomInput = {
  operationId: 'T1:E1',
  tournamentId: 'T1',
  encounterId: 'T1:E1',
  requestHash: 'a'.repeat(64),
  teams: [
    { teamId: 'equipo1', members: [member('p1'), member('p2')] },
    { teamId: 'equipo2', members: [member('p3'), member('p4')] },
  ],
}

describe('GetTournamentRoomRecord (Management#517)', () => {
  it('sala inexistente -> RoomNotFoundError', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const useCase = new GetTournamentRoomRecord(rooms)

    await expect(useCase.execute(ROOM_ID, 0)).rejects.toBeInstanceOf(RoomNotFoundError)
  })

  it('una sala del lobby publico (sin tournament) -> NotATournamentRoomError', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(
      BattleRoom.create(
        ROOM_ID,
        'jugador-1',
        { mode: 'PVP', teamConfigs: [{ capacity: 1 }, { capacity: 1 }], reward: { amount: 0 } },
        AT,
      ),
      0,
    )
    const useCase = new GetTournamentRoomRecord(rooms)

    await expect(useCase.execute(ROOM_ID, 0)).rejects.toBeInstanceOf(NotATournamentRoomError)
  })

  it('una sala PREPARING (sin batalla) trae status, startedAt null, result null, equipos con heroe y pagina vacia', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(
      BattleRoom.createTournamentRoom(ROOM_ID, 'tournament:T1', tournamentInput, AT),
      0,
    )
    const useCase = new GetTournamentRoomRecord(rooms)

    const record = await useCase.execute(ROOM_ID, 0)

    expect(record.roomId).toBe(ROOM_ID)
    expect(record.tournamentId).toBe('T1')
    expect(record.encounterId).toBe('T1:E1')
    expect(record.status).toBe('PREPARING')
    expect(record.startedAt).toBeNull()
    expect(record.result).toBeNull()
    expect(record.teams).toEqual([
      {
        teamId: 'equipo1',
        participants: [
          { kind: 'HUMAN', playerId: 'p1', heroId: 'hero-p1', displayName: 'Nombre p1' },
          { kind: 'HUMAN', playerId: 'p2', heroId: 'hero-p2', displayName: 'Nombre p2' },
        ],
      },
      {
        teamId: 'equipo2',
        participants: [
          { kind: 'HUMAN', playerId: 'p3', heroId: 'hero-p3', displayName: 'Nombre p3' },
          { kind: 'HUMAN', playerId: 'p4', heroId: 'hero-p4', displayName: 'Nombre p4' },
        ],
      },
    ])
    expect(record.events).toEqual({ afterSeq: 0, lastSeq: 0, items: [] })
  })

  describe('tras iniciar la batalla', () => {
    const seedStarted = async (): Promise<InMemoryBattleRoomRepository> => {
      const rooms = new InMemoryBattleRoomRepository()
      await rooms.save(
        BattleRoom.createTournamentRoom(ROOM_ID, 'tournament:T1', tournamentInput, AT),
        0,
      )
      const startBattle = new StartBattle(
        rooms,
        clock,
        heroesPort(),
        scriptedRandom([0, 0, 0, 0, 0, 0, 0, 0]),
        recordingPublisher(),
        recordingBattleCommitments(),
      )
      await new StartTournamentRoom(rooms, startBattle).execute(ROOM_ID, {
        operationId: 'start-1',
        tournamentId: 'T1',
        encounterId: 'T1:E1',
      })

      return rooms
    }

    it('trae status IN_BATTLE, startedAt y el evento battleStarted con seq 1', async () => {
      const rooms = await seedStarted()
      const useCase = new GetTournamentRoomRecord(rooms)

      const record = await useCase.execute(ROOM_ID, 0)

      expect(record.status).toBe('IN_BATTLE')
      expect(record.startedAt).not.toBeNull()
      expect(record.events.lastSeq).toBe(1)
      expect(record.events.items).toHaveLength(1)
      expect(record.events.items[0]).toMatchObject({ type: 'battleStarted', seq: 1 })
    })

    it('pagina desde afterSeq: solo trae eventos con seq > afterSeq', async () => {
      const rooms = await seedStarted()
      const useCase = new GetTournamentRoomRecord(rooms)

      const record = await useCase.execute(ROOM_ID, 1)

      expect(record.events).toEqual({ afterSeq: 1, lastSeq: 1, items: [] })
    })

    it('funciona tambien DESPUES de FINISHED, con el BattleResult (winnerTeamLabel incluido)', async () => {
      const rooms = await seedStarted()
      const current = await rooms.findById(ROOM_ID)
      if (current === null) throw new Error('la sala debia existir')
      const finished = current.finish({ reason: 'ELIMINATION', winnerTeamLabel: 'equipo1' }, AT)
      await rooms.save(finished, current.version)

      const record = await new GetTournamentRoomRecord(rooms).execute(ROOM_ID, 0)

      expect(record.status).toBe('FINISHED')
      expect(record.result?.winnerTeamLabel).toBe('equipo1')
      expect(record.events.items.at(-1)).toMatchObject({ type: 'battleFinished' })
    })

    it('nunca trae mas de 100 eventos en una pagina', async () => {
      const rooms = await seedStarted()
      const current = await rooms.findById(ROOM_ID)
      if (current === null) throw new Error('la sala debia existir')

      // Inyecta eventos sinteticos directamente en la instantanea (atajo de
      // prueba): el proposito es solo verificar el recorte de la pagina, no
      // generar 140 turnos reales.
      const extraEvents: BattleEvent[] = Array.from({ length: 140 }, (_, index) => ({
        seq: current.lastSeq + index + 1,
        type: 'turnAdvanced',
        occurredAt: AT,
        payload: { completedPosition: 0, battle: current.battleView() },
      })) as unknown as BattleEvent[]
      const snapshot = current.toSnapshot()
      const padded = BattleRoom.restore({
        ...snapshot,
        events: [...snapshot.events, ...extraEvents],
      })
      await rooms.save(padded, current.version)

      const record = await new GetTournamentRoomRecord(rooms).execute(ROOM_ID, 0)

      expect(record.events.items).toHaveLength(MAX_TOURNAMENT_RECORD_PAGE_SIZE)
      expect(record.events.lastSeq).toBe(current.lastSeq + 140)
    })
  })
})
