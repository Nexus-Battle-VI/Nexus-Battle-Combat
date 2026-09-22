import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { StakeReleaser } from '../../src/application/services/StakeReleaser'
import { LeaveBattleRoom } from '../../src/application/use-cases/LeaveBattleRoom'
import { silentLogger, walletStakeStub } from '../fixtures/stake'

const AT = new Date('2026-09-21T10:00:00.000Z')
const ROOM_ID = '11111111-1111-4111-8111-111111111111'
const CREATOR = 'a1'
const LEAVER = 'b1'

const roomWithStakes = (): BattleRoom => {
  let room = BattleRoom.create(
    ROOM_ID,
    CREATOR,
    {
      mode: 'PVP',
      teamConfigs: [{ capacity: 2 }, { capacity: 2 }],
      reward: { amount: 0 },
    },
    AT,
  )

  for (const [playerId, team, amount] of [
    [CREATOR, 'A', 10],
    [LEAVER, 'B', 25],
  ] as const) {
    room = room.join(playerId, team, AT, `Nombre ${playerId}`, `heroe-${playerId}`, 1, {
      amount,
      holdOperationId: `battle:${ROOM_ID}:player:${playerId}:stake:reserve`,
    })
  }

  return room.withStakesActivated()
}

const setup = async (walletOverrides: Parameters<typeof walletStakeStub>[0] = {}) => {
  const rooms = new InMemoryBattleRoomRepository()
  await rooms.save(roomWithStakes(), 0)
  const { port, calls } = walletStakeStub(walletOverrides)

  return {
    rooms,
    calls,
    leave: new LeaveBattleRoom(rooms, new StakeReleaser(rooms, port, silentLogger)),
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('LeaveBattleRoom + apuesta (HU-23, D6)', () => {
  it('abandonar libera SOLO la apuesta de quien se va (S-06)', async () => {
    const { rooms, calls, leave } = await setup()

    const dto = await leave.execute(ROOM_ID, LEAVER)
    await flush()
    await flush()

    expect(dto.status).toBe('WAITING_FOR_PLAYERS')
    expect(calls.release).toHaveLength(1)
    expect(calls.release[0]).toMatchObject({
      operationId: `battle:${ROOM_ID}:player:${LEAVER}:stake:release`,
      holdId: `battle:${ROOM_ID}:player:${LEAVER}:stake:reserve`,
      reason: 'PARTICIPANT_LEFT',
    })

    // El resto de la sala sigue reservado.
    const persisted = await rooms.findById(ROOM_ID)
    expect(persisted?.stakeOf(CREATOR)?.status).toBe('ACTIVE')
    expect(persisted?.stakeOf(LEAVER)).toBeNull()
  })

  it('abandonar NUNCA falla porque Wallet este caido', async () => {
    const { calls, leave } = await setup({
      release: () => Promise.reject(new UpstreamServiceError('wallet', 'no_alcanzable')),
    })

    const dto = await leave.execute(ROOM_ID, LEAVER)
    await flush()

    expect(dto.status).toBe('WAITING_FOR_PLAYERS')
    expect(calls.release).toHaveLength(1)
  })

  it('un participante sin apuesta no dispara ninguna liberacion', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const room = BattleRoom.create(
      ROOM_ID,
      CREATOR,
      { mode: 'PVP', teamConfigs: [{ capacity: 2 }, { capacity: 2 }], reward: { amount: 0 } },
      AT,
    ).join(LEAVER, 'B', AT, 'Nombre', 'heroe', 1)
    await rooms.save(room, 0)
    const { port, calls } = walletStakeStub()

    await new LeaveBattleRoom(rooms, new StakeReleaser(rooms, port, silentLogger)).execute(
      ROOM_ID,
      LEAVER,
    )
    await flush()

    expect(calls.release).toHaveLength(0)
  })
})
