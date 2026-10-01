import type { VersusDropCandidate } from '../../domain/entities/VersusDrop'

export interface BattleDropInventorySnapshot {
  readonly battleId: string
  readonly playerId: string
  readonly heroId: string
  readonly loadoutVersion: number
  readonly equipment: readonly VersusDropCandidate[]
}

export interface BattleDropTransferCommand {
  readonly battleId: string
  readonly defeatEventSeq: number
  readonly sourcePlayerId: string
  readonly targetPlayerId: string
  readonly productInstanceId: string
}

export interface BattleDropTransferReceipt extends BattleDropTransferCommand {
  readonly operationId: string
  readonly productId: string
  readonly itemId: string
  readonly creditedAt: string
}

export interface BattleDropInventoryPort {
  capture(command: Omit<BattleDropInventorySnapshot, 'equipment'>): Promise<BattleDropInventorySnapshot>
  find(battleId: string, playerId: string): Promise<BattleDropInventorySnapshot>
  transfer(command: BattleDropTransferCommand): Promise<BattleDropTransferReceipt>
  closeBattle(battleId: string): Promise<void>
}

export const BATTLE_DROP_INVENTORY = Symbol('BattleDropInventory')
