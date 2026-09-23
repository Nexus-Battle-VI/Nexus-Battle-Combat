import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { ListMyActiveBattleRooms } from '../../src/application/use-cases/ListMyActiveBattleRooms'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { finishedRoom, inBattleRoom, preparingRoom } from '../fixtures/battle'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Sala en WAITING_FOR_PLAYERS 2 vs 2 creada en `at`, con `players` unidos. */
const waitingRoom = (id: string, at: Date, players: readonly string[], createdBy = 'dueno') => {
  let room = BattleRoom.create(
    id,
    createdBy,
    { mode: 'PVP', teamConfigs: [{ capacity: 2 }, { capacity: 2 }], reward: { amount: 0 } },
    at,
  )

  for (const player of players) {
    room = room.join(player, null, at, `Nombre ${player}`, `heroe-${player}`, 1)
  }

  return room
}

const persist = async (repo: InMemoryBattleRoomRepository, ...rooms: BattleRoom[]) => {
  for (const room of rooms) {
    await repo.save(room, 0)
  }
}

/**
 * "Volver a mi sala": salas NO terminales donde participa quien pregunta.
 * El jugador sale del testimonio; el caso de uso nunca recibe otro.
 */
describe('ListMyActiveBattleRooms', () => {
  const T1 = new Date('2026-09-20T10:00:00.000Z')
  const T2 = new Date('2026-09-20T11:00:00.000Z')

  it('incluye la sala propia en WAITING_FOR_PLAYERS', async () => {
    const repo = new InMemoryBattleRoomRepository()
    await persist(repo, waitingRoom(uuid(1), T1, ['ana']))

    const rooms = await new ListMyActiveBattleRooms(repo).execute('ana')

    expect(rooms.map((room) => [room.id, room.status])).toEqual([[uuid(1), 'WAITING_FOR_PLAYERS']])
  })

  it('incluye la sala LLENA (ya fuera del listado publico) en PREPARING', async () => {
    const repo = new InMemoryBattleRoomRepository()
    await persist(repo, preparingRoom({ id: uuid(2) }))

    const rooms = await new ListMyActiveBattleRooms(repo).execute('a1')

    expect(rooms.map((room) => room.status)).toEqual(['PREPARING'])
  })

  it('incluye la sala en IN_BATTLE', async () => {
    const repo = new InMemoryBattleRoomRepository()
    await persist(repo, inBattleRoom({ id: uuid(3) }))

    const rooms = await new ListMyActiveBattleRooms(repo).execute('b1')

    expect(rooms.map((room) => room.status)).toEqual(['IN_BATTLE'])
  })

  it('excluye las salas FINISHED y CANCELLED', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const cancelled = waitingRoom(uuid(5), T1, ['a1'], 'a1').cancel('a1')
    await persist(repo, finishedRoom({ id: uuid(4) }), cancelled)

    expect(await new ListMyActiveBattleRooms(repo).execute('a1')).toEqual([])
  })

  it('no incluye salas donde el jugador no participa (sin fuga de salas ajenas)', async () => {
    const repo = new InMemoryBattleRoomRepository()
    await persist(repo, waitingRoom(uuid(6), T1, ['beto']), inBattleRoom({ id: uuid(7) }))

    expect(await new ListMyActiveBattleRooms(repo).execute('ana')).toEqual([])
  })

  it('incluye la sala que el jugador CREO y sigue esperando jugadores, aunque no se uniera', async () => {
    const repo = new InMemoryBattleRoomRepository()
    await persist(repo, waitingRoom(uuid(8), T1, [], 'ana'))

    const rooms = await new ListMyActiveBattleRooms(repo).execute('ana')

    expect(rooms.map((room) => room.id)).toEqual([uuid(8)])
  })

  it('pasada la espera, el creador que NO participa ya no la ve (no podria leerla)', async () => {
    const repo = new InMemoryBattleRoomRepository()
    let full = BattleRoom.create(
      uuid(13),
      'creadora',
      { mode: 'PVP', teamConfigs: [{ capacity: 1 }, { capacity: 1 }], reward: { amount: 0 } },
      T1,
    )
    full = full.join('x', null, T1, 'X', 'heroe-x', 1).join('y', null, T1, 'Y', 'heroe-y', 1)
    await persist(repo, full)

    expect(full.status).toBe('PREPARING')
    expect(await new ListMyActiveBattleRooms(repo).execute('creadora')).toEqual([])
  })

  it('devuelve VARIAS salas, de la mas reciente a la mas antigua', async () => {
    const repo = new InMemoryBattleRoomRepository()
    await persist(repo, waitingRoom(uuid(9), T1, ['ana']), waitingRoom(uuid(10), T2, ['ana']))

    const rooms = await new ListMyActiveBattleRooms(repo).execute('ana')

    expect(rooms.map((room) => room.id)).toEqual([uuid(10), uuid(9)])
  })

  it('un participante IA nunca coincide con un jugador', async () => {
    const repo = new InMemoryBattleRoomRepository()
    await persist(repo, preparingRoom({ id: uuid(11), teamSizes: [1, 1], aiInTeamB: 1 }))

    expect(await new ListMyActiveBattleRooms(repo).execute('ai-0')).toEqual([])
    expect(await new ListMyActiveBattleRooms(repo).execute('a1')).toHaveLength(1)
  })

  it('reutiliza la vista de GET /rooms/:id: la apuesta ajena no se expone', async () => {
    const repo = new InMemoryBattleRoomRepository()
    await persist(repo, preparingRoom({ id: uuid(12), stakes: { a1: 10, b1: 20 } }))

    const [room] = await new ListMyActiveBattleRooms(repo).execute('a1')
    const participants = room?.teams.flatMap((team) => team.participants) ?? []
    const mine = participants.find((participant) => participant.playerId === 'a1')
    const theirs = participants.find((participant) => participant.playerId === 'b1')

    expect(mine?.stake).toMatchObject({ amount: 10 })
    expect(theirs?.stake ?? null).toBeNull()
  })
})
