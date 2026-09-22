import { RewardWorkflowState } from '../../domain/value-objects/RewardWorkflowState'
import type {
  RewardWorkflowRepositoryPort,
  RewardWorkflowSnapshot,
} from '../ports/RewardWorkflowRepositoryPort'

export const RewardDeliveryStatus = {
  None: 'NONE',
  Pending: 'PENDING',
  Confirmed: 'CONFIRMED',
  /**
   * `TERMINAL_FAILURE` (HU-22, corregido en revision): un estado terminal
   * PUBLICO y distinguible de `Pending`, para que el consumidor deje de
   * sondear -- un `TERMINAL_FAILURE` nunca avanza solo (contrato §8), asi
   * que devolverlo como `Pending` invitaba a un sondeo indefinido sin que
   * nada fuera a cambiar jamas.
   */
  Failed: 'FAILED',
} as const

export type RewardDeliveryStatus = (typeof RewardDeliveryStatus)[keyof typeof RewardDeliveryStatus]

export interface RewardStatusView {
  readonly creditsEarned: number | null
  readonly balance: number | null
  readonly victoryProgress: number | null
  readonly weeklyChestCount: number | null
  readonly chestEarned: boolean | null
  readonly rewardDelivery: RewardDeliveryStatus
  readonly reward: {
    readonly productId: string
    readonly sku: string
    readonly name: string
  } | null
}

const NO_WORKFLOW: RewardStatusView = {
  creditsEarned: null,
  balance: null,
  victoryProgress: null,
  weeklyChestCount: null,
  chestEarned: null,
  rewardDelivery: RewardDeliveryStatus.None,
  reward: null,
}

/**
 * `GET /v1/combat/rooms/:roomId/reward` (HU-22, `hu-22-reward-contract-v1`
 * §10). Recuperacion sin depender del evento realtime: un refresh o una
 * reconexion consultan este estado, igual que `snapshot`/`GET` ya hacen para
 * `BattleResult` (HU-21 §6.3).
 */
export class GetRewardStatus {
  constructor(private readonly repository: RewardWorkflowRepositoryPort) {}

  async execute(battleId: string, playerId: string): Promise<RewardStatusView> {
    const workflow = await this.repository.findByBattleAndPlayer(battleId, playerId)

    return workflow === null ? NO_WORKFLOW : toView(workflow)
  }
}

const toView = (workflow: RewardWorkflowSnapshot): RewardStatusView => {
  const reward =
    workflow.rewardProductId !== null && workflow.rewardSku !== null && workflow.rewardName !== null
      ? { productId: workflow.rewardProductId, sku: workflow.rewardSku, name: workflow.rewardName }
      : null

  return {
    creditsEarned: workflow.creditsAmount,
    balance: workflow.balance,
    victoryProgress: workflow.victoryProgress,
    weeklyChestCount: workflow.weeklyChestCount,
    chestEarned: workflow.chestEarned,
    rewardDelivery: deliveryStatusOf(workflow),
    reward,
  }
}

const deliveryStatusOf = (workflow: RewardWorkflowSnapshot): RewardDeliveryStatus => {
  if (workflow.state === RewardWorkflowState.Completed) {
    return workflow.chestEarned === true
      ? RewardDeliveryStatus.Confirmed
      : RewardDeliveryStatus.None
  }

  if (
    workflow.state === RewardWorkflowState.ChestEligible ||
    workflow.state === RewardWorkflowState.RewardSelected
  ) {
    return RewardDeliveryStatus.Pending
  }

  if (workflow.state === RewardWorkflowState.TerminalFailure) {
    // Terminal SIEMPRE se distingue de "en curso": nada va a cambiar sin
    // intervencion (ningun barrido reintenta un TERMINAL_FAILURE, contrato
    // §8). Independiente de `chestEarned`: tanto un credito rechazado
    // (chestEarned aun null) como una entrega de cofre que nunca completo
    // (chestEarned true) son, para quien consulta, la misma cosa -- "esto ya
    // no va a resolverse solo".
    return RewardDeliveryStatus.Failed
  }

  return RewardDeliveryStatus.None
}
