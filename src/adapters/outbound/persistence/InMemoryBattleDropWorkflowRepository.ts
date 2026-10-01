import {
  battleDropWorkflowId,
  type BattleDropWorkflow,
  type BattleDropWorkflowIntent,
  type BattleDropWorkflowRepositoryPort,
} from '../../../application/ports/BattleDropWorkflowRepositoryPort'
import type { BattleDropTransferReceipt } from '../../../application/ports/BattleDropInventoryPort'

/** Doble para suites unitarias; nunca se presenta como persistencia E2E. */
export class InMemoryBattleDropWorkflowRepository implements BattleDropWorkflowRepositoryPort {
  private readonly values = new Map<string, BattleDropWorkflow>()
  private readonly closedBattles = new Set<string>()

  findById(id: string): Promise<BattleDropWorkflow | null> {
    return Promise.resolve(this.values.get(id) ?? null)
  }

  createIfAbsent(intent: BattleDropWorkflowIntent): Promise<BattleDropWorkflow> {
    const id = battleDropWorkflowId(intent.battleId, intent.defeatEventSeq)
    const existing = this.values.get(id)
    if (existing !== undefined) return Promise.resolve(existing)
    const value: BattleDropWorkflow = {
      id,
      ...intent,
      state: intent.resolution.status,
      receipt: null,
      winnerNotified: false,
      loserNotified: false,
    }
    this.values.set(id, value)
    return Promise.resolve(value)
  }

  findUnsettled(limit: number): Promise<readonly BattleDropWorkflow[]> {
    return Promise.resolve(
      [...this.values.values()]
        .filter((entry) => entry.state === 'PENDING' || entry.state === 'FAILED_RETRYABLE')
        .slice(0, limit),
    )
  }

  findUnnotified(limit: number): Promise<readonly BattleDropWorkflow[]> {
    return Promise.resolve(
      [...this.values.values()]
        .filter((entry) => entry.state === 'CREDITED' && (!entry.winnerNotified || !entry.loserNotified))
        .slice(0, limit),
    )
  }

  markCredited(id: string, receipt: BattleDropTransferReceipt): Promise<void> {
    const value = this.values.get(id)
    if (value !== undefined && (value.state === 'PENDING' || value.state === 'FAILED_RETRYABLE')) {
      this.values.set(id, { ...value, state: 'CREDITED', receipt })
    }
    return Promise.resolve()
  }

  markFailed(id: string): Promise<void> {
    const value = this.values.get(id)
    if (value?.state === 'PENDING' || value?.state === 'FAILED_RETRYABLE') {
      this.values.set(id, { ...value, state: 'FAILED_RETRYABLE' })
    }
    return Promise.resolve()
  }

  markNotified(id: string, role: 'winner' | 'loser'): Promise<void> {
    const value = this.values.get(id)
    if (value?.state === 'CREDITED') {
      this.values.set(id, { ...value, [role === 'winner' ? 'winnerNotified' : 'loserNotified']: true })
    }
    return Promise.resolve()
  }

  isBattleClosed(battleId: string): Promise<boolean> {
    return Promise.resolve(this.closedBattles.has(battleId))
  }

  markBattleClosed(battleId: string): Promise<void> {
    this.closedBattles.add(battleId)
    return Promise.resolve()
  }
}
