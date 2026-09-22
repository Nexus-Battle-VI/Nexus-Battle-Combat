/** Combat -> Wallet, `POST /api/internal/v1/wallet/credits/battle-reward` (hu-22-reward-contract-v1 §3). */
export interface RewardCreditCommand {
  readonly operationId: string
  readonly playerId: string
  readonly battleId: string
  readonly creditsAmount: number
  readonly victoryCreditsAmount: number
  readonly occurredAt: Date
}

export interface RewardCreditResult {
  readonly applied: boolean
  readonly balance: number
  readonly victoryProgress: number
  readonly weeklyChestCount: number
  readonly weeklyChestLimit: number
  readonly chestEarned: boolean
}

/**
 * Puerto de salida hacia Wallet (HU-22). Wallet es la unica fuente de verdad
 * del saldo y del progreso de cofre: este puerto solo transporta la
 * solicitud y devuelve lo que Wallet decidio, nunca calcula nada por su
 * cuenta.
 */
export interface RewardCreditPort {
  creditBattleReward(command: RewardCreditCommand): Promise<RewardCreditResult>
}
