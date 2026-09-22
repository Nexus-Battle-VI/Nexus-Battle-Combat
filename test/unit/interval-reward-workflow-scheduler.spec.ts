import { InMemoryRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryRewardWorkflowRepository'
import { IntervalRewardWorkflowScheduler } from '../../src/adapters/outbound/system/IntervalRewardWorkflowScheduler'
import type { RewardWorkflowRepositoryPort } from '../../src/application/ports/RewardWorkflowRepositoryPort'
import type { ProcessRewardWorkflow } from '../../src/application/use-cases/ProcessRewardWorkflow'
import { silentLogger } from '../fixtures/battle'

const intent = (playerId: string) => ({
  battleId: 'room-1',
  playerId,
  teamLabel: 'A',
  seat: 0,
  creditsAmount: 1,
  victoryCreditsAmount: 0,
  finishedAt: new Date('2026-09-22T10:06:00.000Z'),
})

const fakeProcess = (
  handler: (id: string) => Promise<void>,
): ProcessRewardWorkflow & { readonly calls: string[] } => {
  const calls: string[] = []

  return {
    calls,
    execute: async (id: string) => {
      calls.push(id)
      await handler(id)
    },
  } as unknown as ProcessRewardWorkflow & { readonly calls: string[] }
}

describe('IntervalRewardWorkflowScheduler — tick()', () => {
  it('procesa solo los workflows no terminales', async () => {
    const repository: RewardWorkflowRepositoryPort = new InMemoryRewardWorkflowRepository()
    const workflow = await repository.createIfAbsent(intent('sub-1'), 'op-1')
    await repository.applyCompleted(workflow.id) // no-op: sigue en PENDING_CREDIT (no completable desde ahi)
    await repository.applyWalletResult(workflow.id, {
      balance: 1,
      victoryProgress: 0,
      weeklyChestCount: 0,
      chestEarned: false,
    })
    await repository.applyCompleted(workflow.id) // esta si aplica: CREDIT_CONFIRMED -> COMPLETED
    const stillPending = await repository.createIfAbsent(intent('sub-2'), 'op-2')

    const process = fakeProcess(() => Promise.resolve())
    const scheduler = new IntervalRewardWorkflowScheduler(repository, process, silentLogger, {
      autoStart: false,
      tickMs: 1_000,
      batchSize: 50,
    })

    const processed = await scheduler.tick()

    expect(processed).toBe(1)
    expect(process.calls).toEqual([stillPending.id])
  })

  it('no reentra un workflow que ya se esta procesando en el mismo tick', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    await repository.createIfAbsent(intent('sub-1'), 'op-1')

    let concurrentCalls = 0
    let maxConcurrent = 0
    const process = fakeProcess(async () => {
      concurrentCalls += 1
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls)
      await Promise.resolve()
      concurrentCalls -= 1
    })

    const scheduler = new IntervalRewardWorkflowScheduler(repository, process, silentLogger, {
      autoStart: false,
      tickMs: 1_000,
      batchSize: 50,
    })

    await Promise.all([scheduler.tick(), scheduler.tick()])

    expect(maxConcurrent).toBe(1)
  })

  it('un fallo en un workflow se registra y no detiene a los demas', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    await repository.createIfAbsent(intent('sub-fails'), 'op-fails')
    await repository.createIfAbsent(intent('sub-ok'), 'op-ok')

    const errors: Record<string, unknown>[] = []
    const process = fakeProcess((id: string) => {
      if (id.includes('sub-fails')) {
        throw new Error('fallo simulado')
      }

      return Promise.resolve()
    })

    const scheduler = new IntervalRewardWorkflowScheduler(
      repository,
      process,
      { ...silentLogger, error: (_message, context = {}) => errors.push(context) },
      { autoStart: false, tickMs: 1_000, batchSize: 50 },
    )

    const processed = await scheduler.tick()

    expect(processed).toBe(1)
    expect(errors).toHaveLength(1)
    expect(process.calls).toHaveLength(2)
  })

  it('onApplicationBootstrap procesa de inmediato (recupera lo pendiente tras un reinicio)', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    await repository.createIfAbsent(intent('sub-1'), 'op-1')

    const process = fakeProcess(() => Promise.resolve())
    const scheduler = new IntervalRewardWorkflowScheduler(repository, process, silentLogger, {
      autoStart: false,
      tickMs: 1_000,
      batchSize: 50,
    })

    await scheduler.onApplicationBootstrap()

    expect(process.calls).toHaveLength(1)
  })
})
