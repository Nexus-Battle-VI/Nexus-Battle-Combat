import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { StakeReleaser } from '../../src/application/services/StakeReleaser'
import { StakeSettler } from '../../src/application/services/StakeSettler'
import { ReconcileStakes } from '../../src/application/use-cases/ReconcileStakes'
import { finishedRoom, timedOutRoom } from '../fixtures/battle'
import { silentLogger, walletStakeStub } from '../fixtures/stake'

const AT = new Date('2026-09-21T10:00:00.000Z')
const CREATOR = 'a1'

const cancelledRoomWithStake = (id: string, amount = 10): BattleRoom => {
  const room = BattleRoom.create(
    id,
    CREATOR,
    { mode: 'PVP', teamConfigs: [{ capacity: 2 }, { capacity: 2 }], reward: { amount: 0 } },
    AT,
  ).join(CREATOR, 'A', AT, 'Nombre a1', 'heroe-a1', 1, {
    amount,
    holdOperationId: `battle:${id}:player:${CREATOR}:stake:reserve`,
  })

  return room.withStakesActivated().cancel(CREATOR)
}

const setup = async (roomsToSave: readonly BattleRoom[], now: Date = AT) => {
  const rooms = new InMemoryBattleRoomRepository()

  for (const room of roomsToSave) {
    await rooms.save(room, 0)
  }

  const { port, calls } = walletStakeStub()
  const releaser = new StakeReleaser(rooms, port, silentLogger)
  const settler = new StakeSettler(rooms, port, releaser, silentLogger)
  const clock = { now: () => now }

  return {
    rooms,
    calls,
    reconcile: new ReconcileStakes(rooms, settler, releaser, clock),
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('ReconcileStakes (HU-23, contrato §7 y §9)', () => {
  it('una sala FINISHED con ganador y apuestas ACTIVE completa la liquidacion (S-17)', async () => {
    const room = finishedRoom({
      id: '22222222-2222-4222-8222-222222222222',
      stakes: { a1: 10, b1: 10 },
    })
    const { rooms, calls, reconcile } = await setup([room])

    expect(await reconcile.execute()).toBe(1)
    await flush()
    await flush()

    expect(calls.settle).toHaveLength(1)
    expect(calls.settle[0]?.battleId).toBe('22222222-2222-4222-8222-222222222222')

    const persisted = await rooms.findById('22222222-2222-4222-8222-222222222222')
    expect(
      persisted
        ?.stakesAtRisk()
        .map((stake) => stake.status)
        .sort(),
    ).toEqual(['CAPTURED', 'SETTLED_WON'])
  })

  it('una sala FINISHED en NO_WINNER libera todos los holds (S-09)', async () => {
    const room = timedOutRoom({
      id: '33333333-3333-4333-8333-333333333333',
      stakes: { a1: 10, b1: 10 },
    })
    const { rooms, calls, reconcile } = await setup([room])

    expect(await reconcile.execute()).toBe(1)
    await flush()
    await flush()

    expect(calls.release).toHaveLength(2)
    expect(calls.release.every((call) => call.reason === 'NO_WINNER')).toBe(true)
    expect(
      (await rooms.findById('33333333-3333-4333-8333-333333333333'))
        ?.stakesAtRisk()
        .map((stake) => stake.status),
    ).toEqual(['RELEASED', 'RELEASED'])
  })

  it('una sala CANCELLED con apuestas ACTIVE las libera con ROOM_CANCELLED', async () => {
    const { rooms, calls, reconcile } = await setup([
      cancelledRoomWithStake('44444444-4444-4444-8444-444444444444'),
    ])

    expect(await reconcile.execute()).toBe(1)
    await flush()
    await flush()

    expect(calls.release).toHaveLength(1)
    expect(calls.release[0]?.reason).toBe('ROOM_CANCELLED')
    expect(
      (await rooms.findById('44444444-4444-4444-8444-444444444444'))?.stakeOf(CREATOR)?.status,
    ).toBe('RELEASED')
  })

  it('no toca salas sin apuestas ni apuestas ya terminales (no duplica)', async () => {
    const withoutStakes = finishedRoom({ id: '55555555-5555-4555-8555-555555555555' })
    const alreadyReleased = finishedRoom({
      id: '66666666-6666-4666-8666-666666666666',
      stakes: { a1: 10, b1: 10 },
    }).withStakeStatuses([
      {
        holdOperationId: 'battle:66666666-6666-4666-8666-666666666666:player:a1:stake:reserve',
        status: 'RELEASED',
      },
      {
        holdOperationId: 'battle:66666666-6666-4666-8666-666666666666:player:b1:stake:reserve',
        status: 'RELEASED',
      },
    ])
    const { calls, reconcile } = await setup([withoutStakes, alreadyReleased])

    expect(await reconcile.execute()).toBe(0)
    await flush()

    expect(calls.settle).toHaveLength(0)
    expect(calls.release).toHaveLength(0)
  })

  it('una sala terminal fuera de la ventana de 24 h no se retoma', async () => {
    const room = finishedRoom({
      id: '77777777-7777-4777-8777-777777777777',
      stakes: { a1: 10, b1: 10 },
    })
    const twoDaysLater = new Date(AT.getTime() + 48 * 60 * 60 * 1_000)
    const { calls, reconcile } = await setup([room], twoDaysLater)

    expect(await reconcile.execute()).toBe(0)
    await flush()

    expect(calls.settle).toHaveLength(0)
    expect(calls.release).toHaveLength(0)
  })
})
