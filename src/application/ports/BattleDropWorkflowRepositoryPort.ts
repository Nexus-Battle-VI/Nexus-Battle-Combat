import type { VersusDropResolution } from '../../domain/entities/VersusDrop'
import type { BattleDropTransferReceipt } from './BattleDropInventoryPort'

export interface BattleDropWorkflowIntent {
  readonly battleId: string
  readonly defeatEventSeq: number
  readonly killerPlayerId: string
  readonly defeatedPlayerId: string
  readonly resolution: VersusDropResolution
}

export interface BattleDropWorkflow extends BattleDropWorkflowIntent {
  readonly id: string
  readonly state: 'NO_DROP' | 'AWAITING_TIE_RULE' | 'PENDING' | 'CREDITED' | 'FAILED_RETRYABLE'
  readonly receipt: BattleDropTransferReceipt | null
  readonly winnerNotified: boolean
  readonly loserNotified: boolean
}

export const battleDropWorkflowId = (battleId: string, defeatEventSeq: number): string =>
  `${battleId}:${String(defeatEventSeq)}`

export interface BattleDropWorkflowRepositoryPort {
  findById(id: string): Promise<BattleDropWorkflow | null>
  createIfAbsent(intent: BattleDropWorkflowIntent): Promise<BattleDropWorkflow>
  findUnsettled(limit: number): Promise<readonly BattleDropWorkflow[]>
  findUnnotified(limit: number): Promise<readonly BattleDropWorkflow[]>
  markCredited(id: string, receipt: BattleDropTransferReceipt): Promise<void>
  markFailed(id: string): Promise<void>
  markNotified(id: string, role: 'winner' | 'loser'): Promise<void>
  isBattleClosed(battleId: string): Promise<boolean>
  markBattleClosed(battleId: string): Promise<void>
}

export const BATTLE_DROP_WORKFLOWS = Symbol('BattleDropWorkflows')
