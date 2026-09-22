import { InMemoryRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryRewardWorkflowRepository'
import {
  GetRewardStatus,
  RewardDeliveryStatus,
} from '../../src/application/use-cases/GetRewardStatus'

const intent = (overrides: { creditsAmount?: number; victoryCreditsAmount?: number } = {}) => ({
  battleId: 'room-1',
  playerId: 'sub-1',
  teamLabel: 'A',
  seat: 0,
  creditsAmount: overrides.creditsAmount ?? 4,
  victoryCreditsAmount: overrides.victoryCreditsAmount ?? 4,
  finishedAt: new Date('2026-09-22T10:06:00.000Z'),
})

describe('GetRewardStatus', () => {
  it('sin workflow: NONE, todo null (no error)', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const useCase = new GetRewardStatus(repository)

    const status = await useCase.execute('room-inexistente', 'sub-1')

    expect(status).toEqual({
      creditsEarned: null,
      balance: null,
      victoryProgress: null,
      weeklyChestCount: null,
      chestEarned: null,
      rewardDelivery: RewardDeliveryStatus.None,
      reward: null,
    })
  })

  it('PENDING_CREDIT: se conoce creditsEarned, el resto sigue null, delivery NONE', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    await repository.createIfAbsent(intent(), 'op-1')
    const status = await new GetRewardStatus(repository).execute('room-1', 'sub-1')

    expect(status).toMatchObject({
      creditsEarned: 4,
      balance: null,
      rewardDelivery: RewardDeliveryStatus.None,
    })
  })

  it('CREDIT_CONFIRMED sin cofre: delivery NONE, reward null, pero balance/progreso visibles', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await repository.createIfAbsent(
      intent({ creditsAmount: 1, victoryCreditsAmount: 0 }),
      'op-1',
    )
    await repository.applyWalletResult(workflow.id, {
      balance: 1,
      victoryProgress: 5,
      weeklyChestCount: 0,
      chestEarned: false,
    })

    const status = await new GetRewardStatus(repository).execute('room-1', 'sub-1')

    expect(status).toMatchObject({
      balance: 1,
      victoryProgress: 5,
      chestEarned: false,
      rewardDelivery: RewardDeliveryStatus.None,
      reward: null,
    })
  })

  it('CHEST_ELIGIBLE: delivery PENDING, reward todavia null', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await repository.createIfAbsent(intent(), 'op-1')
    await repository.applyWalletResult(workflow.id, {
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      chestEarned: true,
    })

    const status = await new GetRewardStatus(repository).execute('room-1', 'sub-1')

    expect(status).toMatchObject({
      rewardDelivery: RewardDeliveryStatus.Pending,
      reward: null,
      chestEarned: true,
    })
  })

  it('COMPLETED con cofre: delivery CONFIRMED, reward completo', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await repository.createIfAbsent(intent(), 'op-1')
    await repository.applyWalletResult(workflow.id, {
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      chestEarned: true,
    })
    await repository.applySelection(workflow.id, {
      productId: 'p-1',
      sku: 'sku-1',
      name: 'Espada',
      inventoryOperationId: 'inv-op-1',
    })
    await repository.applyCompleted(workflow.id)

    const status = await new GetRewardStatus(repository).execute('room-1', 'sub-1')

    expect(status).toMatchObject({
      rewardDelivery: RewardDeliveryStatus.Confirmed,
      reward: { productId: 'p-1', sku: 'sku-1', name: 'Espada' },
    })
  })

  it('COMPLETED sin cofre: delivery NONE (nunca CONFIRMED sin cofre real)', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await repository.createIfAbsent(
      intent({ creditsAmount: 1, victoryCreditsAmount: 0 }),
      'op-1',
    )
    await repository.applyWalletResult(workflow.id, {
      balance: 1,
      victoryProgress: 0,
      weeklyChestCount: 0,
      chestEarned: false,
    })
    await repository.applyCompleted(workflow.id)

    const status = await new GetRewardStatus(repository).execute('room-1', 'sub-1')

    expect(status.rewardDelivery).toBe(RewardDeliveryStatus.None)
  })

  it('TERMINAL_FAILURE con cofre ganado: delivery FAILED, nunca CONFIRMED sin confirmacion real ni PENDING indefinido', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await repository.createIfAbsent(intent(), 'op-1')
    await repository.applyWalletResult(workflow.id, {
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      chestEarned: true,
    })
    await repository.applyTerminalFailure(workflow.id, 'inventory: error_servidor')

    const status = await new GetRewardStatus(repository).execute('room-1', 'sub-1')

    expect(status.rewardDelivery).toBe(RewardDeliveryStatus.Failed)
    // El saldo y el progreso ya confirmados por Wallet siguen visibles: solo
    // fallo la entrega del cofre, el credito ya acreditado no se revierte.
    expect(status).toMatchObject({ balance: 20, chestEarned: true })
  })

  it('TERMINAL_FAILURE antes de confirmar el credito (Wallet rechazo terminal): delivery FAILED, no NONE ni PENDING', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await repository.createIfAbsent(intent(), 'op-1')
    await repository.applyTerminalFailure(workflow.id, 'wallet: monto_invalido')

    const status = await new GetRewardStatus(repository).execute('room-1', 'sub-1')

    expect(status.rewardDelivery).toBe(RewardDeliveryStatus.Failed)
    expect(status.balance).toBeNull()
  })

  it('solo devuelve el estado del jugador consultado, no el de otro', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    await repository.createIfAbsent(intent(), 'op-1')
    await repository.createIfAbsent(
      { ...intent(), playerId: 'sub-2', creditsAmount: 1, victoryCreditsAmount: 0 },
      'op-2',
    )

    const status = await new GetRewardStatus(repository).execute('room-1', 'sub-2')

    expect(status.creditsEarned).toBe(1)
  })
})
