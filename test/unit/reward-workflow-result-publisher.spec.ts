import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { RewardWorkflowResultPublisher } from '../../src/adapters/outbound/system/RewardWorkflowResultPublisher'
import type { BattleFinishedNotification } from '../../src/application/ports/BattleResultPublisherPort'
import type {
  WalletStakePort,
  WalletStakeReleaseCommand,
  WalletStakeReserveCommand,
  WalletStakeSettleCommand,
} from '../../src/application/ports/WalletStakePort'
import type { CreateRewardWorkflows } from '../../src/application/use-cases/CreateRewardWorkflows'
import type { ProcessRewardWorkflow } from '../../src/application/use-cases/ProcessRewardWorkflow'
import type { RewardWorkflowSnapshot } from '../../src/application/ports/RewardWorkflowRepositoryPort'
import { StakeReleaser } from '../../src/application/services/StakeReleaser'
import { StakeSettler } from '../../src/application/services/StakeSettler'
import { finishedRoom, timedOutRoom } from '../fixtures/battle'
import { RewardWorkflowState } from '../../src/domain/value-objects/RewardWorkflowState'
import type { Logger } from '../../src/infrastructure/observability/logger'

const notification: BattleFinishedNotification = {
  roomId: 'room-1',
  mode: 'PVP',
  finishedAt: '2026-09-22T10:06:00.000Z',
  reason: 'ELIMINATION',
  outcome: 'WIN',
  winnerTeamLabel: 'A',
  participants: [],
  configuredReward: { amount: 0 },
}

const workflow = (id: string): RewardWorkflowSnapshot => ({
  id,
  battleId: 'room-1',
  playerId: id,
  teamLabel: 'A',
  seat: 0,
  creditsAmount: 2,
  victoryCreditsAmount: 2,
  finishedAt: new Date(),
  state: RewardWorkflowState.PendingCredit,
  walletOperationId: `op-${id}`,
  balance: null,
  victoryProgress: null,
  weeklyChestCount: null,
  chestEarned: null,
  rewardProductId: null,
  rewardSku: null,
  rewardName: null,
  inventoryOperationId: null,
  failureReason: null,
  attempts: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
})

const flush = () => new Promise((resolve) => setImmediate(resolve))

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

interface WalletStakeCalls {
  readonly reserve: WalletStakeReserveCommand[]
  readonly release: WalletStakeReleaseCommand[]
  readonly settle: WalletStakeSettleCommand[]
}

const walletStakeStub = (
  overrides: Partial<WalletStakePort> = {},
): { readonly port: WalletStakePort; readonly calls: WalletStakeCalls } => {
  const calls: WalletStakeCalls = { reserve: [], release: [], settle: [] }

  const port: WalletStakePort = {
    reserve: (command) => {
      calls.reserve.push(command)
      return Promise.resolve({
        operationId: command.operationId,
        applied: true,
        holdId: command.operationId,
        balance: 100,
        reserved: command.amount,
        available: 100 - command.amount,
      })
    },
    release: (command) => {
      calls.release.push(command)
      return Promise.resolve({
        operationId: command.operationId,
        applied: true,
        holdId: command.holdId,
        balance: 100,
        reserved: 0,
        available: 100,
      })
    },
    settle: (command) => {
      calls.settle.push(command)
      return Promise.resolve({ operationId: command.operationId, applied: true, results: [] })
    },
    ...overrides,
  }

  return { port, calls }
}

interface PublisherHarness {
  readonly publisher: RewardWorkflowResultPublisher
  readonly rooms: InMemoryBattleRoomRepository
  readonly calls: WalletStakeCalls
}

const buildPublisher = async (
  room: ReturnType<typeof finishedRoom> | null,
  options: {
    readonly createWorkflows?: Partial<CreateRewardWorkflows>
    readonly processWorkflow?: Partial<ProcessRewardWorkflow>
    readonly wallet?: Partial<WalletStakePort>
    readonly logger?: Logger
  } = {},
): Promise<PublisherHarness> => {
  const rooms = new InMemoryBattleRoomRepository()

  if (room !== null) {
    await rooms.save(room, 0)
  }

  const createWorkflows = {
    execute: () => Promise.resolve([]),
    ...options.createWorkflows,
  } as unknown as CreateRewardWorkflows
  const processWorkflow = {
    execute: () => Promise.resolve(),
    ...options.processWorkflow,
  } as unknown as ProcessRewardWorkflow
  const { port, calls } = walletStakeStub(options.wallet)
  const logger = options.logger ?? silentLogger
  const releaser = new StakeReleaser(rooms, port, logger)
  const settler = new StakeSettler(rooms, port, releaser, logger)

  return {
    rooms,
    calls,
    publisher: new RewardWorkflowResultPublisher(
      createWorkflows,
      processWorkflow,
      rooms,
      settler,
      releaser,
      logger,
    ),
  }
}

describe('RewardWorkflowResultPublisher (HU-21 contrato S9 + HU-22)', () => {
  it('conserva el registro battle_finished con los mismos 4 campos minimizados', async () => {
    const infoCalls: Record<string, unknown>[] = []
    const logger = {
      ...silentLogger,
      info: (_message: string, context: Record<string, unknown> = {}) => {
        infoCalls.push(context)
      },
    }
    const { publisher } = await buildPublisher(null, { logger })

    publisher.publish(notification)

    expect(infoCalls).toEqual([
      { roomId: 'room-1', reason: 'ELIMINATION', outcome: 'WIN', winnerTeamLabel: 'A' },
    ])
  })

  it('publish() es sincrono: no espera a que termine la creacion/procesamiento de workflows', async () => {
    let resolveCreate!: (value: RewardWorkflowSnapshot[]) => void
    const { publisher } = await buildPublisher(null, {
      createWorkflows: {
        execute: () =>
          new Promise<RewardWorkflowSnapshot[]>((resolve) => {
            resolveCreate = resolve
          }),
      },
    })

    const before = Date.now()
    publisher.publish(notification)
    const elapsed = Date.now() - before

    expect(elapsed).toBeLessThan(50)
    resolveCreate([])
  })

  it('crea los workflows y los procesa de inmediato, uno por participante', async () => {
    const created = [workflow('sub-1'), workflow('sub-2')]
    const processedIds: string[] = []
    const { publisher } = await buildPublisher(null, {
      createWorkflows: { execute: () => Promise.resolve(created) },
      processWorkflow: {
        execute: (id: string) => {
          processedIds.push(id)
          return Promise.resolve()
        },
      },
    })

    publisher.publish(notification)
    await flush()
    await flush()

    expect(processedIds.sort()).toEqual(['sub-1', 'sub-2'])
  })

  it('un fallo al crear/procesar los workflows se registra y NO lanza (nunca revierte la batalla)', async () => {
    const errors: Record<string, unknown>[] = []
    const logger = {
      ...silentLogger,
      error: (_message: string, context: Record<string, unknown> = {}) => {
        errors.push(context)
      },
    }
    const { publisher } = await buildPublisher(null, {
      createWorkflows: { execute: () => Promise.reject(new Error('mongo caido')) },
      logger,
    })

    expect(() => {
      publisher.publish(notification)
    }).not.toThrow()

    await flush()
    await flush()

    expect(errors).toEqual([{ roomId: 'room-1', reason: 'Error' }])
  })
})

describe('RewardWorkflowResultPublisher (HU-23: apuestas)', () => {
  it('WIN con apuestas: llama a /settle UNA vez y marca CAPTURED/SETTLED_WON (S-07)', async () => {
    const room = finishedRoom({ stakes: { a1: 10, b1: 10 } })
    const { publisher, rooms, calls } = await buildPublisher(room)

    publisher.publish({
      ...notification,
      roomId: room.id,
      participants: [],
    })
    await flush()
    await flush()
    await flush()

    expect(calls.settle).toHaveLength(1)
    expect(calls.settle[0]).toMatchObject({
      operationId: `battle:${room.id}:stakes:settle`,
      battleId: room.id,
    })
    expect(calls.settle[0]?.settlements).toEqual(
      expect.arrayContaining([
        { playerId: 'b1', holdId: expect.any(String), outcome: 'CAPTURED', amount: 10 },
        { playerId: 'a1', holdId: expect.any(String), outcome: 'CREDITED', amount: 10 },
      ]),
    )
    expect(calls.release).toHaveLength(0)

    const persisted = await rooms.findById(room.id)
    const stakes = new Map(persisted?.stakesAtRisk().map((stake) => [stake.playerId, stake.status]))
    expect(stakes.get('b1')).toBe('CAPTURED')
    expect(stakes.get('a1')).toBe('SETTLED_WON')
  })

  it('NO_WINNER: libera TODOS los holds con reason NO_WINNER, sin llamar a /settle (S-09)', async () => {
    const room = timedOutRoom({ stakes: { a1: 10, b1: 10 } })
    const { publisher, rooms, calls } = await buildPublisher(room)

    publisher.publish({ ...notification, roomId: room.id, outcome: 'NO_WINNER' })
    await flush()
    await flush()
    await flush()

    expect(calls.settle).toHaveLength(0)
    expect(calls.release).toHaveLength(2)
    expect(calls.release.map((call) => call.reason)).toEqual(['NO_WINNER', 'NO_WINNER'])

    const persisted = await rooms.findById(room.id)
    expect(persisted?.stakesAtRisk().map((stake) => stake.status)).toEqual(['RELEASED', 'RELEASED'])
  })

  it('una sala sin ninguna apuesta no llama a Wallet (S-11)', async () => {
    const room = finishedRoom()
    const { publisher, calls } = await buildPublisher(room)

    publisher.publish({ ...notification, roomId: room.id })
    await flush()
    await flush()

    expect(calls.reserve).toHaveLength(0)
    expect(calls.release).toHaveLength(0)
    expect(calls.settle).toHaveLength(0)
  })

  it('un fallo de Wallet en la apuesta NO afecta a los creditos de HU-22 ni lanza', async () => {
    const room = finishedRoom({ stakes: { a1: 10, b1: 10 } })
    const processedIds: string[] = []
    const errors: Record<string, unknown>[] = []
    const { publisher } = await buildPublisher(room, {
      wallet: {
        settle: () => Promise.reject(new Error('wallet caido')),
      },
      createWorkflows: { execute: () => Promise.resolve([workflow('sub-1')]) },
      processWorkflow: {
        execute: (id: string) => {
          processedIds.push(id)
          return Promise.resolve()
        },
      },
      logger: {
        ...silentLogger,
        error: (_message: string, context: Record<string, unknown> = {}) => {
          errors.push(context)
        },
      },
    })

    expect(() => {
      publisher.publish({ ...notification, roomId: room.id })
    }).not.toThrow()

    await flush()
    await flush()
    await flush()

    // Los creditos de HU-22 siguen su camino aunque la apuesta falle.
    expect(processedIds).toEqual(['sub-1'])
    expect(errors.some((context) => context.battleId === room.id)).toBe(true)
  })
})
