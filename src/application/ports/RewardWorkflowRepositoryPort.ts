import type { RewardWorkflowState } from '../../domain/value-objects/RewardWorkflowState'

/** Intencion de crear un workflow para UN participante HUMANO de una batalla terminada. */
export interface RewardWorkflowIntent {
  readonly battleId: string
  readonly playerId: string
  readonly teamLabel: string
  readonly seat: number
  readonly creditsAmount: number
  readonly victoryCreditsAmount: number
  readonly finishedAt: Date
}

export interface RewardWorkflowSnapshot {
  readonly id: string
  readonly battleId: string
  readonly playerId: string
  readonly teamLabel: string
  readonly seat: number
  readonly creditsAmount: number
  readonly victoryCreditsAmount: number
  readonly finishedAt: Date
  readonly state: RewardWorkflowState
  readonly walletOperationId: string
  readonly balance: number | null
  readonly victoryProgress: number | null
  readonly weeklyChestCount: number | null
  readonly chestEarned: boolean | null
  readonly rewardProductId: string | null
  readonly rewardSku: string | null
  readonly rewardName: string | null
  readonly inventoryOperationId: string | null
  readonly failureReason: string | null
  readonly attempts: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface WalletResultInput {
  readonly balance: number
  readonly victoryProgress: number
  readonly weeklyChestCount: number
  readonly chestEarned: boolean
}

export interface RewardSelectionInput {
  readonly productId: string
  readonly sku: string
  readonly name: string
  readonly inventoryOperationId: string
}

/**
 * Persistencia del `RewardWorkflow` (HU-22, `hu-22-reward-contract-v1` §8).
 *
 * Cada metodo de transicion es IDEMPOTENTE y ATOMICO: filtra por el `state`
 * de origen esperado, de modo que dos llamadas concurrentes sobre el mismo
 * workflow (el barrido y un intento inmediato tras crearlo) nunca aplican la
 * misma transicion dos veces. Una transicion que no encuentra el estado de
 * origen esperado devuelve el snapshot ACTUAL sin escribir nada (no-op): otra
 * escritura ya avanzo el workflow.
 */
export interface RewardWorkflowRepositoryPort {
  /**
   * Crea el workflow en `PENDING_CREDIT` si no existe (`id` determinista
   * `battleId:playerId`). Si ya existe, lo devuelve tal cual: la creacion es
   * idempotente por diseno, igual que el resto del contrato.
   */
  createIfAbsent(
    intent: RewardWorkflowIntent,
    walletOperationId: string,
  ): Promise<RewardWorkflowSnapshot>

  findById(id: string): Promise<RewardWorkflowSnapshot | null>

  findByBattleAndPlayer(battleId: string, playerId: string): Promise<RewardWorkflowSnapshot | null>

  /** Workflows que no llegaron a un estado terminal, para el barrido y la recuperacion al arrancar. */
  findNonTerminal(limit: number): Promise<readonly RewardWorkflowSnapshot[]>

  /** `PENDING_CREDIT` -> `CREDIT_CONFIRMED` (sin cofre) o `CHEST_ELIGIBLE` (con cofre). */
  applyWalletResult(id: string, result: WalletResultInput): Promise<RewardWorkflowSnapshot>

  /** `CHEST_ELIGIBLE` -> `REWARD_SELECTED`. El productId ya sorteado queda fijo. */
  applySelection(id: string, selection: RewardSelectionInput): Promise<RewardWorkflowSnapshot>

  /** `CREDIT_CONFIRMED` (sin cofre) o `REWARD_SELECTED` (con cofre, tras el grant) -> `COMPLETED`. */
  applyCompleted(id: string): Promise<RewardWorkflowSnapshot>

  /** Cualquier estado no terminal -> `TERMINAL_FAILURE`. No se reintenta solo. */
  applyTerminalFailure(id: string, reason: string): Promise<RewardWorkflowSnapshot>

  /** Registra un intento fallido TRANSITORIO sin cambiar de estado (lo recoge el siguiente barrido). */
  registerRetryableFailure(id: string, reason: string): Promise<void>
}
