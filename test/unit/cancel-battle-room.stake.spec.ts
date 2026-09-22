import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { StakeReleaser } from '../../src/application/services/StakeReleaser'
import { CancelBattleRoom } from '../../src/application/use-cases/CancelBattleRoom'
import { silentLogger, walletStakeStub } from '../fixtures/stake'

const AT = new Date('2026-09-21T10:00:00.000Z')
const ROOM_ID = '11111111-1111-4111-8111-111111111111'
const CREATOR = 'a1'

const roomWithStakes = (stakes: Readonly<Record<string, number>>): BattleRoom => {
  const room = BattleRoom.create(
    ROOM_ID,
    CREATOR,
    {
      mode: 'PVP',
      teamConfigs: [{ capacity: 2 }, { capacity: 2 }],
      reward: { amount: 0 },
    },
    AT,
  )

  let current = room

  for (const [playerId, amount] of Object.entries(stakes)) {
    current = current.join(
      playerId,
      playerId.startsWith('a') ? 'A' : 'B',
      AT,
      `Nombre ${playerId}`,
      `heroe-${playerId}`,
      1,
      {
        amount,
        holdOperationId: `battle:${ROOM_ID}:player:${playerId}:stake:reserve`,
      },
    )
  }

  return current.withStakesActivated()
}

const setup = async (
  stakes: Readonly<Record<string, number>>,
  walletOverrides: Parameters<typeof walletStakeStub>[0] = {},
) => {
  const rooms = new InMemoryBattleRoomRepository()
  await rooms.save(roomWithStakes(stakes), 0)
  const { port, calls } = walletStakeStub(walletOverrides)

  return {
    rooms,
    calls,
    cancel: new CancelBattleRoom(rooms, new StakeReleaser(rooms, port, silentLogger)),
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('CancelBattleRoom + apuesta (HU-23, D6/§7)', () => {
  it('cancela y libera TODAS las apuestas ACTIVE con reason ROOM_CANCELLED (S-05)', async () => {
    const { rooms, calls, cancel } = await setup({ a1: 10, b1: 25 })

    const dto = await cancel.execute(ROOM_ID, CREATOR)
    await flush()
    await flush()

    expect(dto.status).toBe('CANCELLED')
    expect(calls.release).toHaveLength(2)
    expect(calls.release.map((call) => call.reason)).toEqual(['ROOM_CANCELLED', 'ROOM_CANCELLED'])
    expect(calls.release.map((call) => call.holdId).sort()).toEqual([
      `battle:${ROOM_ID}:player:a1:stake:reserve`,
      `battle:${ROOM_ID}:player:b1:stake:reserve`,
    ])

    const persisted = await rooms.findById(ROOM_ID)
    expect(persisted?.stakesAtRisk().map((stake) => stake.status)).toEqual(['RELEASED', 'RELEASED'])
  })

  it('cancelar NUNCA falla porque Wallet este caido: la sala queda CANCELLED y la liberacion se recupera (S-05)', async () => {
    const { rooms, calls, cancel } = await setup(
      { a1: 10 },
      { release: () => Promise.reject(new UpstreamServiceError('wallet', 'no_alcanzable')) },
    )

    const dto = await cancel.execute(ROOM_ID, CREATOR)
    await flush()
    await flush()

    expect(dto.status).toBe('CANCELLED')
    expect(calls.release).toHaveLength(1)

    // La intencion sigue persistida: el barrido de recuperacion la retoma.
    const persisted = await rooms.findById(ROOM_ID)
    expect(persisted?.status).toBe('CANCELLED')
    expect(persisted?.stakeOf(CREATOR)?.status).toBe('ACTIVE')
  })

  it('una sala sin apuestas no llama a Wallet', async () => {
    const { calls, cancel } = await setup({})

    await cancel.execute(ROOM_ID, CREATOR)
    await flush()

    expect(calls.release).toHaveLength(0)
  })
})
