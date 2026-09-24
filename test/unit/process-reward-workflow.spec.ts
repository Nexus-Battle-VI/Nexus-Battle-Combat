import { InMemoryRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryRewardWorkflowRepository'
import {
  RewardOperationConflictError,
  RewardRejectedError,
} from '../../src/application/errors/RewardIntegrationErrors'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type {
  RewardCreditCommand,
  RewardCreditPort,
  RewardCreditResult,
} from '../../src/application/ports/RewardCreditPort'
import type {
  RewardGrantCommand,
  RewardGrantPort,
  RewardGrantResult,
} from '../../src/application/ports/RewardGrantPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import {
  ProcessRewardWorkflow,
  type ProcessRewardWorkflowLogger,
} from '../../src/application/use-cases/ProcessRewardWorkflow'
import { RewardTable, type RewardEntry } from '../../src/domain/reward/RewardTable'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import { RewardWorkflowState } from '../../src/domain/value-objects/RewardWorkflowState'

const silentLogger: ProcessRewardWorkflowLogger = { info: () => undefined, error: () => undefined }

const systemClock: ClockPort = { now: () => new Date() }

/** Reloj adelantado: la espera entre reintentos (`RewardRetryPolicy`) ya vencio. */
const oneHourLater: ClockPort = { now: () => new Date(Date.now() + 60 * 60_000) }

const rewardEntry: RewardEntry = {
  productId: 'product-1',
  sku: 'sku-1',
  name: 'Espada',
  tierId: 'RARA',
}

const table = RewardTable.fromRanges([{ firstRow: 1, lastRow: 8000, entry: rewardEntry }])

class FixedSequence implements RandomSequencePort {
  constructor(private readonly values: number[]) {}
  nextIndex(): RandomIndex {
    const value = this.values.shift()
    if (value === undefined) throw new Error('Secuencia agotada en la prueba.')
    return RandomIndex.create(value)
  }
}

class FakeCreditPort implements RewardCreditPort {
  calls: RewardCreditCommand[] = []
  constructor(
    private readonly result: RewardCreditResult | ((command: RewardCreditCommand) => never),
  ) {}
  creditBattleReward(command: RewardCreditCommand): Promise<RewardCreditResult> {
    this.calls.push(command)
    if (typeof this.result === 'function') {
      return Promise.resolve(this.result(command))
    }
    return Promise.resolve(this.result)
  }
}

class RejectingCreditPort implements RewardCreditPort {
  constructor(private readonly error: Error) {}
  creditBattleReward(): Promise<RewardCreditResult> {
    return Promise.reject(this.error)
  }
}

class FakeGrantPort implements RewardGrantPort {
  calls: RewardGrantCommand[] = []
  grant(command: RewardGrantCommand): Promise<RewardGrantResult> {
    this.calls.push(command)
    return Promise.resolve({ applied: true })
  }
}

class RejectingGrantPort implements RewardGrantPort {
  constructor(private readonly error: Error) {}
  grant(): Promise<RewardGrantResult> {
    return Promise.reject(this.error)
  }
}

const seedWorkflow = async (
  repository: InMemoryRewardWorkflowRepository,
  overrides: { creditsAmount?: number; victoryCreditsAmount?: number } = {},
) =>
  repository.createIfAbsent(
    {
      battleId: 'room-1',
      playerId: 'sub-1',
      teamLabel: 'A',
      seat: 0,
      creditsAmount: overrides.creditsAmount ?? 2,
      victoryCreditsAmount: overrides.victoryCreditsAmount ?? 2,
      finishedAt: new Date('2026-09-22T10:06:00.000Z'),
    },
    'battle:room-1:player:sub-1:credit',
  )

describe('ProcessRewardWorkflow', () => {
  it('sin cofre: PENDING_CREDIT -> CREDIT_CONFIRMED -> COMPLETED, sin tocar Inventory', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await seedWorkflow(repository)
    const credit = new FakeCreditPort({
      applied: true,
      balance: 2,
      victoryProgress: 2,
      weeklyChestCount: 0,
      weeklyChestLimit: 2,
      chestEarned: false,
    })
    const grant = new FakeGrantPort()
    const useCase = new ProcessRewardWorkflow(
      repository,
      credit,
      grant,
      new FixedSequence([]),
      table,
      silentLogger,
      systemClock,
    )

    await useCase.execute(workflow.id)

    const finalState = await repository.findById(workflow.id)
    expect(finalState).toMatchObject({
      state: RewardWorkflowState.Completed,
      chestEarned: false,
      balance: 2,
    })
    expect(grant.calls).toHaveLength(0)
  })

  it('con cofre: recorre PENDING_CREDIT -> CHEST_ELIGIBLE -> REWARD_SELECTED -> COMPLETED', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await seedWorkflow(repository, { creditsAmount: 4, victoryCreditsAmount: 4 })
    const credit = new FakeCreditPort({
      applied: true,
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      weeklyChestLimit: 2,
      chestEarned: true,
    })
    const grant = new FakeGrantPort()
    const useCase = new ProcessRewardWorkflow(
      repository,
      credit,
      grant,
      new FixedSequence([4000]),
      table,
      silentLogger,
      systemClock,
    )

    await useCase.execute(workflow.id)

    const finalState = await repository.findById(workflow.id)
    expect(finalState).toMatchObject({
      state: RewardWorkflowState.Completed,
      chestEarned: true,
      rewardProductId: 'product-1',
      rewardSku: 'sku-1',
      rewardName: 'Espada',
    })
    expect(grant.calls).toEqual([
      {
        operationId: 'battle:room-1:player:sub-1:chest:1:grant',
        playerId: 'sub-1',
        productId: 'product-1',
        quantity: 1,
      },
    ])
  })

  it('un rechazo 422 de Wallet deja el workflow en TERMINAL_FAILURE sin llamar a Inventory', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await seedWorkflow(repository)
    const credit = new RejectingCreditPort(
      new RewardRejectedError('wallet', 'monto invalido', 'INVALID'),
    )
    const grant = new FakeGrantPort()
    const useCase = new ProcessRewardWorkflow(
      repository,
      credit,
      grant,
      new FixedSequence([]),
      table,
      silentLogger,
      systemClock,
    )

    await useCase.execute(workflow.id)

    const finalState = await repository.findById(workflow.id)
    expect(finalState?.state).toBe(RewardWorkflowState.TerminalFailure)
    expect(grant.calls).toHaveLength(0)
  })

  it('un conflicto 409 de Wallet deja el workflow en TERMINAL_FAILURE', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await seedWorkflow(repository)
    const credit = new RejectingCreditPort(new RewardOperationConflictError('wallet', 'op-1'))
    const useCase = new ProcessRewardWorkflow(
      repository,
      credit,
      new FakeGrantPort(),
      new FixedSequence([]),
      table,
      silentLogger,
      systemClock,
    )

    await useCase.execute(workflow.id)

    expect((await repository.findById(workflow.id))?.state).toBe(
      RewardWorkflowState.TerminalFailure,
    )
  })

  it('un fallo transitorio (503) de Wallet NO cambia el estado: queda para el siguiente barrido', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await seedWorkflow(repository)
    const credit = new RejectingCreditPort(new UpstreamServiceError('wallet', 'error_servidor'))
    const useCase = new ProcessRewardWorkflow(
      repository,
      credit,
      new FakeGrantPort(),
      new FixedSequence([]),
      table,
      silentLogger,
      systemClock,
    )

    await useCase.execute(workflow.id)

    const finalState = await repository.findById(workflow.id)
    expect(finalState?.state).toBe(RewardWorkflowState.PendingCredit)
    expect(finalState?.attempts).toBe(1)
  })

  it('el saldo ya acreditado NO se revierte si Inventory falla despues (HU-22 S66)', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await seedWorkflow(repository, { creditsAmount: 4, victoryCreditsAmount: 4 })
    const credit = new FakeCreditPort({
      applied: true,
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      weeklyChestLimit: 2,
      chestEarned: true,
    })
    const grant = new RejectingGrantPort(
      new UpstreamServiceError('player-inventory', 'error_servidor'),
    )
    const useCase = new ProcessRewardWorkflow(
      repository,
      credit,
      grant,
      new FixedSequence([100]),
      table,
      silentLogger,
      systemClock,
    )

    await useCase.execute(workflow.id)

    const finalState = await repository.findById(workflow.id)
    // El credito quedo confirmado (balance/progreso persistidos) aunque el
    // grant fallara: solo la entrega del cofre queda pendiente.
    expect(finalState?.balance).toBe(20)
    expect(finalState?.chestEarned).toBe(true)
    expect(finalState?.state).toBe(RewardWorkflowState.RewardSelected)
  })

  it('un retry tras fallo de Inventory reutiliza el MISMO producto ya sorteado, no vuelve a sortear', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await seedWorkflow(repository, { creditsAmount: 4, victoryCreditsAmount: 4 })
    const credit = new FakeCreditPort({
      applied: true,
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      weeklyChestLimit: 2,
      chestEarned: true,
    })
    const sequence = new FixedSequence([7000])
    const failingGrant = new RejectingGrantPort(
      new UpstreamServiceError('player-inventory', 'error_servidor'),
    )
    const firstAttempt = new ProcessRewardWorkflow(
      repository,
      credit,
      failingGrant,
      sequence,
      table,
      silentLogger,
      systemClock,
    )
    await firstAttempt.execute(workflow.id)

    const afterFirstFailure = await repository.findById(workflow.id)
    expect(afterFirstFailure?.rewardProductId).toBe('product-1')

    const workingGrant = new FakeGrantPort()
    // Secuencia vacia a proposito: si el codigo intentara sortear de nuevo,
    // `FixedSequence.nextIndex()` lanzaria y la prueba fallaria.
    const retry = new ProcessRewardWorkflow(
      repository,
      credit,
      workingGrant,
      new FixedSequence([]),
      table,
      silentLogger,
      oneHourLater,
    )
    await retry.execute(workflow.id)

    expect(workingGrant.calls[0]?.productId).toBe('product-1')
    expect((await repository.findById(workflow.id))?.state).toBe(RewardWorkflowState.Completed)
  })

  it('un workflow inexistente no hace nada', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const useCase = new ProcessRewardWorkflow(
      repository,
      new FakeCreditPort({
        applied: true,
        balance: 0,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weeklyChestLimit: 2,
        chestEarned: false,
      }),
      new FakeGrantPort(),
      new FixedSequence([]),
      table,
      silentLogger,
      systemClock,
    )

    await expect(useCase.execute('no-existe')).resolves.toBeUndefined()
  })

  it('un workflow ya COMPLETED no se reprocesa', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await seedWorkflow(repository)
    const credit = new FakeCreditPort({
      applied: true,
      balance: 2,
      victoryProgress: 2,
      weeklyChestCount: 0,
      weeklyChestLimit: 2,
      chestEarned: false,
    })
    const grant = new FakeGrantPort()
    const useCase = new ProcessRewardWorkflow(
      repository,
      credit,
      grant,
      new FixedSequence([]),
      table,
      silentLogger,
      systemClock,
    )
    await useCase.execute(workflow.id)
    expect(credit.calls).toHaveLength(1)

    await useCase.execute(workflow.id)

    expect(credit.calls).toHaveLength(1)
  })
})
