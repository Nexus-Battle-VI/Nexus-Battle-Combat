import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { StakeRejectedError } from '../../src/application/errors/StakeIntegrationErrors'
import type { CreateBattleRoomInput } from '../../src/domain/entities/BattleRoom'
import { StakeNotAllowedInPveError } from '../../src/domain/errors/StakeErrors'
import { CreateBattleRoom } from '../../src/application/use-cases/CreateBattleRoom'
import { StakeReserver } from '../../src/application/services/StakeReserver'
import { silentLogger, walletStakeStub } from '../fixtures/stake'

const AT = new Date('2026-09-21T10:00:00.000Z')
const ROOM_ID = '11111111-1111-4111-8111-111111111111'
const CREATOR = 'a1'

const clock = { now: () => AT }
const ids = { generate: () => ROOM_ID }

const inputWithStake = (amount: number, mode: 'PVP' | 'PVE' = 'PVP'): CreateBattleRoomInput => ({
  mode,
  teamConfigs: [
    { capacity: 1, initialParticipants: [{ kind: 'HUMAN', stake: { amount } }] },
    mode === 'PVE' ? { capacity: 1, initialParticipants: [{ kind: 'AI' }] } : { capacity: 1 },
  ],
  reward: { amount: 0 },
})

const setup = (walletOverrides: Parameters<typeof walletStakeStub>[0] = {}) => {
  const rooms = new InMemoryBattleRoomRepository()
  const { port, calls } = walletStakeStub(walletOverrides)

  return {
    rooms,
    calls,
    create: new CreateBattleRoom(rooms, ids, clock, new StakeReserver(port, clock, silentLogger)),
  }
}

describe('CreateBattleRoom + apuesta (HU-23, D8)', () => {
  it('reserva de forma SINCRONA antes de persistir y guarda la sala con la apuesta ACTIVE (S-01)', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const { port, calls } = walletStakeStub({
      reserve: (command) =>
        // La sala AUN no esta persistida: la reserva ocurre antes del save.
        rooms.findById(ROOM_ID).then((room) => {
          expect(room).toBeNull()

          return {
            operationId: command.operationId,
            applied: true,
            holdId: command.operationId,
            balance: 100,
            reserved: command.amount,
            available: 100 - command.amount,
          }
        }),
    })
    const create = new CreateBattleRoom(
      rooms,
      ids,
      clock,
      new StakeReserver(port, clock, silentLogger),
    )

    const dto = await create.execute(CREATOR, inputWithStake(10))

    expect(calls.reserve).toHaveLength(1)
    expect(calls.reserve[0]).toMatchObject({
      operationId: `battle:${ROOM_ID}:player:${CREATOR}:stake:reserve`,
      playerId: CREATOR,
      battleId: ROOM_ID,
      amount: 10,
      occurredAt: AT,
    })

    const persisted = await rooms.findById(ROOM_ID)
    expect(persisted?.stakeOf(CREATOR)).toMatchObject({
      amount: 10,
      status: 'ACTIVE',
      holdOperationId: `battle:${ROOM_ID}:player:${CREATOR}:stake:reserve`,
    })
    expect(dto.stakePool).toEqual({ total: 10 })
  })

  it('si Wallet rechaza, el create completo falla y NADA se persiste (S-03)', async () => {
    const { rooms, calls, create } = setup({
      reserve: () =>
        Promise.reject(
          new StakeRejectedError('wallet', 'sin saldo', 'INSUFFICIENT_AVAILABLE_BALANCE'),
        ),
    })

    await expect(create.execute(CREATOR, inputWithStake(10))).rejects.toBeInstanceOf(
      StakeRejectedError,
    )

    expect(calls.reserve).toHaveLength(1)
    expect(await rooms.findById(ROOM_ID)).toBeNull()
  })

  it('PVE con apuesta se rechaza ANTES de llamar a Wallet (S-16)', async () => {
    const { rooms, calls, create } = setup()

    await expect(create.execute(CREATOR, inputWithStake(10, 'PVE'))).rejects.toBeInstanceOf(
      StakeNotAllowedInPveError,
    )

    expect(calls.reserve).toHaveLength(0)
    expect(await rooms.findById(ROOM_ID)).toBeNull()
  })

  it('sin apuesta no se llama a Wallet y la sala se persiste igual que antes de HU-23 (S-04)', async () => {
    const { rooms, calls, create } = setup()

    const dto = await create.execute(CREATOR, {
      mode: 'PVP',
      teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
      reward: { amount: 0 },
    })

    expect(calls.reserve).toHaveLength(0)
    expect(dto.stakePool).toEqual({ total: 0 })
    expect((await rooms.findById(ROOM_ID))?.stakesAtRisk()).toEqual([])
  })

  it('la apuesta del creador solo viaja al DTO del PROPIO creador', async () => {
    const { create } = setup()

    const dto = await create.execute(CREATOR, inputWithStake(10))
    const ownParticipant = dto.teams[0].participants[0]

    expect(ownParticipant?.stake).toEqual({ amount: 10, status: 'ACTIVE' })
  })
})
