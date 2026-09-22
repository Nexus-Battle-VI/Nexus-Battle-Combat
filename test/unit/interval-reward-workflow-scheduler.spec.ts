import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryRewardWorkflowRepository'
import { IntervalRewardWorkflowScheduler } from '../../src/adapters/outbound/system/IntervalRewardWorkflowScheduler'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import type { RewardWorkflowRepositoryPort } from '../../src/application/ports/RewardWorkflowRepositoryPort'
import { CreateRewardWorkflows } from '../../src/application/use-cases/CreateRewardWorkflows'
import { ProcessRewardWorkflow } from '../../src/application/use-cases/ProcessRewardWorkflow'
import { ReconcileRewardWorkflows } from '../../src/application/use-cases/ReconcileRewardWorkflows'
import type { RewardTable } from '../../src/domain/reward/RewardTable'
import { silentLogger } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'

const fakeReconcile = (
  handler: (since: Date) => Promise<number> = () => Promise.resolve(0),
): ReconcileRewardWorkflows & { readonly calls: Date[] } => {
  const calls: Date[] = []

  return {
    calls,
    execute: async (since: Date) => {
      calls.push(since)

      return handler(since)
    },
  } as unknown as ReconcileRewardWorkflows & { readonly calls: Date[] }
}

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
    const scheduler = new IntervalRewardWorkflowScheduler(
      repository,
      process,
      fakeReconcile(),
      silentLogger,
      { autoStart: false, tickMs: 1_000, batchSize: 50, reconcileWindowMs: 86_400_000 },
    )

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

    const scheduler = new IntervalRewardWorkflowScheduler(
      repository,
      process,
      fakeReconcile(),
      silentLogger,
      { autoStart: false, tickMs: 1_000, batchSize: 50, reconcileWindowMs: 86_400_000 },
    )

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
      fakeReconcile(),
      { ...silentLogger, error: (_message, context = {}) => errors.push(context) },
      { autoStart: false, tickMs: 1_000, batchSize: 50, reconcileWindowMs: 86_400_000 },
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
    const reconcile = fakeReconcile()
    const scheduler = new IntervalRewardWorkflowScheduler(
      repository,
      process,
      reconcile,
      silentLogger,
      { autoStart: false, tickMs: 1_000, batchSize: 50, reconcileWindowMs: 86_400_000 },
    )

    await scheduler.onApplicationBootstrap()

    expect(process.calls).toHaveLength(1)
    // Reconciliacion ANTES del barrido, con la ventana convertida a instante (HU-22).
    expect(reconcile.calls).toHaveLength(1)
  })
})

/**
 * Regresion del hueco de crash detectado en la revision de HU-22: si
 * `RewardWorkflowResultPublisher.publish()` no llega a persistir el
 * `RewardWorkflow` de una sala ya `FINISHED` (el proceso muere justo entre
 * ambas escrituras), `onApplicationBootstrap` debe recrearlo Y procesarlo en
 * la MISMA pasada -- no basta con que exista para el siguiente tick, porque
 * un reinicio sin trafico nuevo no dispara otro.
 */
describe('IntervalRewardWorkflowScheduler — onApplicationBootstrap con ReconcileRewardWorkflows real', () => {
  it('un RewardWorkflow que nunca se creo se recrea y se procesa en el mismo arranque', async () => {
    // Relativo al reloj real (no a la fecha fija de otras pruebas): el bootstrap
    // calcula `since` a partir de `Date.now()`, y una fecha fija se saldria de la
    // ventana de reconciliacion segun el dia en que corra la prueba.
    const AT = new Date(Date.now() - 5 * 60_000)
    const room = battleWithCombat({ health: { 'B#0': 0 } }).finish(
      { reason: 'ELIMINATION', winnerTeamLabel: 'A' },
      AT,
    )
    const rooms = new InMemoryBattleRoomRepository()

    await rooms.save(room, 0)

    const workflows = new InMemoryRewardWorkflowRepository()
    const createWorkflows = new CreateRewardWorkflows(workflows)
    const reconcile = new ReconcileRewardWorkflows(rooms, createWorkflows, silentLogger)
    const process = new ProcessRewardWorkflow(
      workflows,
      { creditBattleReward: () => Promise.reject(new Error('sin Wallet en esta prueba')) },
      { grant: () => Promise.reject(new Error('sin Inventory en esta prueba')) },
      // El estado inicial (PENDING_CREDIT) falla siempre contra Wallet, asi que
      // nunca llega a consumir la secuencia ni la tabla: no necesitan ser reales.
      {} as unknown as RandomSequencePort,
      {} as unknown as RewardTable,
      silentLogger,
    )

    expect(await workflows.findByBattleAndPlayer(room.id, 'a1')).toBeNull()

    const scheduler = new IntervalRewardWorkflowScheduler(
      workflows,
      process,
      reconcile,
      silentLogger,
      {
        autoStart: false,
        tickMs: 1_000,
        batchSize: 50,
        reconcileWindowMs: 86_400_000,
      },
    )

    await scheduler.onApplicationBootstrap()

    const created = await workflows.findByBattleAndPlayer(room.id, 'a1')

    expect(created).not.toBeNull()
    // No se quedo en PENDING_CREDIT: el tick() del mismo arranque ya lo recogio
    // y avanzo (aqui falla contra Wallet, pero eso prueba que SI se intento).
    expect(created?.attempts).toBeGreaterThan(0)
  })
})
