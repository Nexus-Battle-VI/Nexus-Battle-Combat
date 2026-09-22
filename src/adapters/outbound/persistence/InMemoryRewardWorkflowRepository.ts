import type {
  RewardSelectionInput,
  RewardWorkflowIntent,
  RewardWorkflowRepositoryPort,
  RewardWorkflowSnapshot,
  WalletResultInput,
} from '../../../application/ports/RewardWorkflowRepositoryPort'
import { RewardWorkflowState } from '../../../domain/value-objects/RewardWorkflowState'

const workflowId = (battleId: string, playerId: string): string => `${battleId}:${playerId}`

const NON_TERMINAL_STATES: ReadonlySet<RewardWorkflowState> = new Set([
  RewardWorkflowState.PendingCredit,
  RewardWorkflowState.CreditConfirmed,
  RewardWorkflowState.ChestEligible,
  RewardWorkflowState.RewardSelected,
])

const COMPLETABLE_FROM: ReadonlySet<RewardWorkflowState> = new Set([
  RewardWorkflowState.CreditConfirmed,
  RewardWorkflowState.RewardSelected,
])

/** Doble de pruebas/desarrollo. Misma semantica de transiciones atomicas que `MongoRewardWorkflowRepository`. */
export class InMemoryRewardWorkflowRepository implements RewardWorkflowRepositoryPort {
  private readonly workflows = new Map<string, RewardWorkflowSnapshot>()

  createIfAbsent(
    intent: RewardWorkflowIntent,
    walletOperationId: string,
  ): Promise<RewardWorkflowSnapshot> {
    const id = workflowId(intent.battleId, intent.playerId)
    const existing = this.workflows.get(id)

    if (existing !== undefined) {
      return Promise.resolve(existing)
    }

    const now = new Date()
    const created: RewardWorkflowSnapshot = {
      id,
      battleId: intent.battleId,
      playerId: intent.playerId,
      teamLabel: intent.teamLabel,
      seat: intent.seat,
      creditsAmount: intent.creditsAmount,
      victoryCreditsAmount: intent.victoryCreditsAmount,
      finishedAt: intent.finishedAt,
      state: RewardWorkflowState.PendingCredit,
      walletOperationId,
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
      createdAt: now,
      updatedAt: now,
    }

    this.workflows.set(id, created)

    return Promise.resolve(created)
  }

  findById(id: string): Promise<RewardWorkflowSnapshot | null> {
    return Promise.resolve(this.workflows.get(id) ?? null)
  }

  findByBattleAndPlayer(
    battleId: string,
    playerId: string,
  ): Promise<RewardWorkflowSnapshot | null> {
    return this.findById(workflowId(battleId, playerId))
  }

  findNonTerminal(limit: number): Promise<readonly RewardWorkflowSnapshot[]> {
    const all = [...this.workflows.values()].filter((workflow) =>
      NON_TERMINAL_STATES.has(workflow.state),
    )

    return Promise.resolve(all.slice(0, limit))
  }

  applyWalletResult(id: string, result: WalletResultInput): Promise<RewardWorkflowSnapshot> {
    return Promise.resolve(
      this.transition(id, RewardWorkflowState.PendingCredit, {
        state: result.chestEarned
          ? RewardWorkflowState.ChestEligible
          : RewardWorkflowState.CreditConfirmed,
        balance: result.balance,
        victoryProgress: result.victoryProgress,
        weeklyChestCount: result.weeklyChestCount,
        chestEarned: result.chestEarned,
      }),
    )
  }

  applySelection(id: string, selection: RewardSelectionInput): Promise<RewardWorkflowSnapshot> {
    return Promise.resolve(
      this.transition(id, RewardWorkflowState.ChestEligible, {
        state: RewardWorkflowState.RewardSelected,
        rewardProductId: selection.productId,
        rewardSku: selection.sku,
        rewardName: selection.name,
        inventoryOperationId: selection.inventoryOperationId,
      }),
    )
  }

  applyCompleted(id: string): Promise<RewardWorkflowSnapshot> {
    const current = this.workflows.get(id)

    if (current === undefined || !COMPLETABLE_FROM.has(current.state)) {
      return Promise.resolve(this.mustGet(id))
    }

    return Promise.resolve(this.set(id, { ...current, state: RewardWorkflowState.Completed }))
  }

  applyTerminalFailure(id: string, reason: string): Promise<RewardWorkflowSnapshot> {
    const current = this.workflows.get(id)

    if (current === undefined || !NON_TERMINAL_STATES.has(current.state)) {
      return Promise.resolve(this.mustGet(id))
    }

    return Promise.resolve(
      this.set(id, {
        ...current,
        state: RewardWorkflowState.TerminalFailure,
        failureReason: reason,
      }),
    )
  }

  registerRetryableFailure(id: string, reason: string): Promise<void> {
    const current = this.workflows.get(id)

    if (current !== undefined) {
      this.set(id, { ...current, failureReason: reason, attempts: current.attempts + 1 })
    }

    return Promise.resolve()
  }

  private transition(
    id: string,
    expected: RewardWorkflowState,
    patch: Partial<RewardWorkflowSnapshot>,
  ): RewardWorkflowSnapshot {
    const current = this.workflows.get(id)

    if (current?.state !== expected) {
      return this.mustGet(id)
    }

    return this.set(id, { ...current, ...patch })
  }

  private set(id: string, next: RewardWorkflowSnapshot): RewardWorkflowSnapshot {
    const updated = { ...next, updatedAt: new Date() }

    this.workflows.set(id, updated)

    return updated
  }

  private mustGet(id: string): RewardWorkflowSnapshot {
    const workflow = this.workflows.get(id)

    if (workflow === undefined) {
      throw new Error(`RewardWorkflow "${id}" no existe.`)
    }

    return workflow
  }
}
