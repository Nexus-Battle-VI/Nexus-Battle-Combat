import { RewardWorkflowResultPublisher } from '../../src/adapters/outbound/system/RewardWorkflowResultPublisher'
import type { BattleFinishedNotification } from '../../src/application/ports/BattleResultPublisherPort'
import type { CreateRewardWorkflows } from '../../src/application/use-cases/CreateRewardWorkflows'
import type { ProcessRewardWorkflow } from '../../src/application/use-cases/ProcessRewardWorkflow'
import type { RewardWorkflowSnapshot } from '../../src/application/ports/RewardWorkflowRepositoryPort'
import { RewardWorkflowState } from '../../src/domain/value-objects/RewardWorkflowState'

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

describe('RewardWorkflowResultPublisher (HU-21 contrato S9 + HU-22)', () => {
  it('conserva el registro battle_finished con los mismos 4 campos minimizados', () => {
    const infoCalls: Record<string, unknown>[] = []
    const logger = {
      debug: () => undefined,
      info: (_message: string, context: Record<string, unknown> = {}) => infoCalls.push(context),
      warn: () => undefined,
      error: () => undefined,
    }
    const createWorkflows = {
      execute: () => Promise.resolve([]),
    } as unknown as CreateRewardWorkflows
    const processWorkflow = { execute: () => Promise.resolve() } as unknown as ProcessRewardWorkflow

    new RewardWorkflowResultPublisher(createWorkflows, processWorkflow, logger).publish(
      notification,
    )

    expect(infoCalls).toEqual([
      { roomId: 'room-1', reason: 'ELIMINATION', outcome: 'WIN', winnerTeamLabel: 'A' },
    ])
  })

  it('publish() es sincrono: no espera a que termine la creacion/procesamiento de workflows', () => {
    let resolveCreate!: (value: RewardWorkflowSnapshot[]) => void
    const createWorkflows = {
      execute: () =>
        new Promise<RewardWorkflowSnapshot[]>((resolve) => {
          resolveCreate = resolve
        }),
    } as unknown as CreateRewardWorkflows
    const processWorkflow = { execute: () => Promise.resolve() } as unknown as ProcessRewardWorkflow
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }

    const before = Date.now()
    new RewardWorkflowResultPublisher(createWorkflows, processWorkflow, logger).publish(
      notification,
    )
    const elapsed = Date.now() - before

    expect(elapsed).toBeLessThan(50)
    resolveCreate([])
  })

  it('crea los workflows y los procesa de inmediato, uno por participante', async () => {
    const created = [workflow('sub-1'), workflow('sub-2')]
    const createWorkflows = {
      execute: () => Promise.resolve(created),
    } as unknown as CreateRewardWorkflows
    const processedIds: string[] = []
    const processWorkflow = {
      execute: (id: string) => {
        processedIds.push(id)
        return Promise.resolve()
      },
    } as unknown as ProcessRewardWorkflow
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }

    new RewardWorkflowResultPublisher(createWorkflows, processWorkflow, logger).publish(
      notification,
    )
    await flush()
    await flush()

    expect(processedIds.sort()).toEqual(['sub-1', 'sub-2'])
  })

  it('un fallo al crear/procesar los workflows se registra y NO lanza (nunca revierte la batalla)', async () => {
    const createWorkflows = {
      execute: () => Promise.reject(new Error('mongo caido')),
    } as unknown as CreateRewardWorkflows
    const processWorkflow = { execute: () => Promise.resolve() } as unknown as ProcessRewardWorkflow
    const errors: Record<string, unknown>[] = []
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (_message: string, context: Record<string, unknown> = {}) => errors.push(context),
    }

    expect(() => {
      new RewardWorkflowResultPublisher(createWorkflows, processWorkflow, logger).publish(
        notification,
      )
    }).not.toThrow()

    await flush()
    await flush()

    expect(errors).toEqual([{ roomId: 'room-1', reason: 'Error' }])
  })
})
