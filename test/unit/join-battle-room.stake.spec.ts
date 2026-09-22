import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { StakeRejectedError } from '../../src/application/errors/StakeIntegrationErrors'
import type { AccountBattleProfilePort } from '../../src/application/ports/AccountBattleProfilePort'
import type { PlayerInventoryEquippedHeroPort } from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { StakeNotAllowedInPveError } from '../../src/domain/errors/StakeErrors'
import { StakeReserver } from '../../src/application/services/StakeReserver'
import { JoinBattleRoom } from '../../src/application/use-cases/JoinBattleRoom'
import { equippedHeroFixture } from '../fixtures/equipped-hero'
import { silentLogger, walletStakeStub } from '../fixtures/stake'

const AT = new Date('2026-09-21T10:00:00.000Z')
const ROOM_ID = '11111111-1111-4111-8111-111111111111'
const CREATOR = 'a1'
const JOINER = 'b1'

const clock = { now: () => AT }

const accountProfiles: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `nombre-${subject}`, avatarUrl: null }),
}

const equippedHeroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) => Promise.resolve(equippedHeroFixture({ playerId })),
}

const saveRoom = async (
  rooms: InMemoryBattleRoomRepository,
  mode: 'PVP' | 'PVE' = 'PVP',
  creatorStake?: number,
): Promise<BattleRoom> => {
  const room = BattleRoom.create(
    ROOM_ID,
    CREATOR,
    {
      mode,
      teamConfigs:
        mode === 'PVE'
          ? [{ capacity: 2 }, { capacity: 2, initialParticipants: [{ kind: 'AI' }] }]
          : [
              {
                capacity: 2,
                initialParticipants: [
                  {
                    kind: 'HUMAN',
                    playerId: CREATOR,
                    ...(creatorStake === undefined
                      ? {}
                      : {
                          stake: {
                            amount: creatorStake,
                            holdOperationId: `battle:${ROOM_ID}:player:${CREATOR}:stake:reserve`,
                          },
                        }),
                  },
                ],
              },
              { capacity: 2 },
            ],
      reward: { amount: 0 },
    },
    AT,
  ).withStakesActivated()

  return rooms.save(room, 0)
}

const setup = async (
  walletOverrides: Parameters<typeof walletStakeStub>[0] = {},
  options: { mode?: 'PVP' | 'PVE'; creatorStake?: number } = {},
) => {
  const rooms = new InMemoryBattleRoomRepository()
  await saveRoom(rooms, options.mode ?? 'PVP', options.creatorStake)
  const { port, calls } = walletStakeStub(walletOverrides)

  return {
    rooms,
    calls,
    join: new JoinBattleRoom(
      rooms,
      clock,
      accountProfiles,
      equippedHeroes,
      new StakeReserver(port, clock, silentLogger),
    ),
  }
}

describe('JoinBattleRoom + apuesta (HU-23, D8)', () => {
  it('reserva antes de persistir la union y deja la apuesta ACTIVE (S-02)', async () => {
    const { rooms, calls, join } = await setup({}, { creatorStake: 5 })

    const dto = await join.execute(ROOM_ID, JOINER, 'B', { amount: 15 })

    expect(calls.reserve).toHaveLength(1)
    expect(calls.reserve[0]).toMatchObject({
      operationId: `battle:${ROOM_ID}:player:${JOINER}:stake:reserve`,
      playerId: JOINER,
      battleId: ROOM_ID,
      amount: 15,
    })

    const persisted = await rooms.findById(ROOM_ID)
    expect(persisted?.stakeOf(JOINER)).toMatchObject({ amount: 15, status: 'ACTIVE' })

    const own = dto.teams[1].participants[0]
    expect(own?.stake).toEqual({ amount: 15, status: 'ACTIVE' })
    // §10: la apuesta del rival (a1) NO viaja al DTO de b1.
    expect(dto.teams[0].participants[0]).not.toHaveProperty('stake')
    // El resumen agregado si: 15 + 5 del creador.
    expect(dto.stakePool).toEqual({ total: 20 })
  })

  it('si Wallet rechaza, la union NO se persiste y el join completo falla (S-03)', async () => {
    const { rooms, join } = await setup({
      reserve: () =>
        Promise.reject(
          new StakeRejectedError('wallet', 'sin saldo', 'INSUFFICIENT_AVAILABLE_BALANCE'),
        ),
    })

    await expect(join.execute(ROOM_ID, JOINER, 'B', { amount: 15 })).rejects.toBeInstanceOf(
      StakeRejectedError,
    )

    const persisted = await rooms.findById(ROOM_ID)
    expect(persisted?.isParticipant(JOINER)).toBe(false)
    expect(persisted?.stakeOf(JOINER)).toBeNull()
  })

  it('PVE con apuesta se rechaza ANTES de llamar a Wallet (S-16)', async () => {
    const { rooms, calls, join } = await setup({}, { mode: 'PVE' })

    await expect(join.execute(ROOM_ID, JOINER, 'A', { amount: 10 })).rejects.toBeInstanceOf(
      StakeNotAllowedInPveError,
    )

    expect(calls.reserve).toHaveLength(0)
    expect((await rooms.findById(ROOM_ID))?.isParticipant(JOINER)).toBe(false)
  })

  it('unirse sin apuesta (o con 0) no llama a Wallet: comportamiento igual al de antes (S-04)', async () => {
    const { rooms, calls, join } = await setup()

    await join.execute(ROOM_ID, JOINER, 'B')
    await join.execute(ROOM_ID, 'b2', 'B', { amount: 0 })

    expect(calls.reserve).toHaveLength(0)
    const persisted = await rooms.findById(ROOM_ID)
    expect(persisted?.stakeOf(JOINER)).toBeNull()
    expect(persisted?.stakeOf('b2')).toBeNull()
  })
})
