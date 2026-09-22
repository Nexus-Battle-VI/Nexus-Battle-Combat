/**
 * Contrato interno Combat -> Wallet de apuestas (HU-23,
 * `hu-23-battle-stake-v1` §5). Wallet es la unica fuente de verdad del dinero:
 * este puerto solo transporta la solicitud y devuelve lo que Wallet decidio.
 */

export type StakeReleaseReason = 'ROOM_CANCELLED' | 'PARTICIPANT_LEFT' | 'NO_WINNER'

export type StakeSettlementOutcome = 'CAPTURED' | 'CREDITED'

export interface WalletStakeReserveCommand {
  /** `battle:{battleId}:player:{playerId}:stake:reserve`, sin hashear. */
  readonly operationId: string
  readonly playerId: string
  readonly battleId: string
  readonly amount: number
  readonly occurredAt: Date
}

export interface WalletStakeReleaseCommand {
  readonly operationId: string
  readonly holdId: string
  readonly reason: StakeReleaseReason
}

export interface WalletStakeSettlementEntry {
  readonly playerId: string
  readonly holdId: string
  readonly outcome: StakeSettlementOutcome
  readonly amount: number
}

export interface WalletStakeSettleCommand {
  /** `battle:{battleId}:stakes:settle`: UNO por batalla (D10). */
  readonly operationId: string
  readonly battleId: string
  readonly settlements: readonly WalletStakeSettlementEntry[]
}

/** Respuesta de `reserve`/`release`: el estado de la cuenta tras aplicarlo. */
export interface WalletStakeOperationResult {
  readonly operationId: string
  /** `false` cuando la respuesta es el replay de una operacion ya aplicada. */
  readonly applied: boolean
  readonly holdId: string
  readonly balance: number
  readonly reserved: number
  readonly available: number
}

export interface WalletStakeSettlementResult {
  readonly playerId: string
  readonly holdId: string
  readonly balance: number
  readonly reserved: number
  readonly available: number
}

export interface WalletStakeSettleResult {
  readonly operationId: string
  readonly applied: boolean
  readonly results: readonly WalletStakeSettlementResult[]
}

export interface WalletStakePort {
  reserve(command: WalletStakeReserveCommand): Promise<WalletStakeOperationResult>
  release(command: WalletStakeReleaseCommand): Promise<WalletStakeOperationResult>
  settle(command: WalletStakeSettleCommand): Promise<WalletStakeSettleResult>
}

export const WALLET_STAKE_PORT = Symbol('WalletStakePort')
