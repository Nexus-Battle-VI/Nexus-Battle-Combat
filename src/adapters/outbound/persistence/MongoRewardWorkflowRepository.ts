import type { Collection, Db } from 'mongodb'

import type {
  RewardSelectionInput,
  RewardWorkflowIntent,
  RewardWorkflowRepositoryPort,
  RewardWorkflowSnapshot,
  WalletResultInput,
} from '../../../application/ports/RewardWorkflowRepositoryPort'
import { RewardWorkflowState } from '../../../domain/value-objects/RewardWorkflowState'

export const REWARD_WORKFLOWS_COLLECTION = 'reward-workflows'

export interface RewardWorkflowDocument {
  readonly _id: string
  readonly battleId: string
  readonly playerId: string
  readonly teamLabel: string
  readonly seat: number
  readonly creditsAmount: number
  readonly victoryCreditsAmount: number
  readonly finishedAt: Date
  state: string
  balance: number | null
  victoryProgress: number | null
  weeklyChestCount: number | null
  chestEarned: boolean | null
  readonly walletOperationId: string
  rewardProductId: string | null
  rewardSku: string | null
  rewardName: string | null
  inventoryOperationId: string | null
  failureReason: string | null
  attempts: number
  readonly createdAt: Date
  updatedAt: Date
}

const workflowId = (battleId: string, playerId: string): string => `${battleId}:${playerId}`

const NON_TERMINAL_STATES: readonly string[] = [
  RewardWorkflowState.PendingCredit,
  RewardWorkflowState.CreditConfirmed,
  RewardWorkflowState.ChestEligible,
  RewardWorkflowState.RewardSelected,
]

const COMPLETABLE_FROM: readonly string[] = [
  RewardWorkflowState.CreditConfirmed,
  RewardWorkflowState.RewardSelected,
]

/**
 * Persistencia del `RewardWorkflow` sobre MongoDB (HU-22, Task HU-22.3).
 *
 * Cada transicion filtra por el `state` de ORIGEN esperado
 * (`findOneAndUpdate`) y es, por tanto, un no-op segura si otra escritura ya
 * avanzo el workflow -- mismo criterio de concurrencia que
 * `MongoChatMessageRepository` (indice/filtro como unica defensa, sin
 * transaccion: el barrido de un solo proceso, ADR-019/ADR-011, ya serializa
 * los intentos con `inFlight`).
 */
export class MongoRewardWorkflowRepository implements RewardWorkflowRepositoryPort {
  private readonly workflows: Collection<RewardWorkflowDocument>

  constructor(db: Db) {
    this.workflows = db.collection<RewardWorkflowDocument>(REWARD_WORKFLOWS_COLLECTION)
  }

  async createIfAbsent(
    intent: RewardWorkflowIntent,
    walletOperationId: string,
  ): Promise<RewardWorkflowSnapshot> {
    const id = workflowId(intent.battleId, intent.playerId)
    const now = new Date()

    await this.workflows.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
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
        },
      },
      { upsert: true },
    )

    return this.mustFind(id)
  }

  async findById(id: string): Promise<RewardWorkflowSnapshot | null> {
    const document = await this.workflows.findOne({ _id: id })

    return document === null ? null : toSnapshot(document)
  }

  async findByBattleAndPlayer(
    battleId: string,
    playerId: string,
  ): Promise<RewardWorkflowSnapshot | null> {
    return this.findById(workflowId(battleId, playerId))
  }

  async findNonTerminal(limit: number): Promise<readonly RewardWorkflowSnapshot[]> {
    const documents = await this.workflows
      .find({ state: { $in: [...NON_TERMINAL_STATES] } })
      .limit(limit)
      .toArray()

    return documents.map(toSnapshot)
  }

  async applyWalletResult(id: string, result: WalletResultInput): Promise<RewardWorkflowSnapshot> {
    const nextState = result.chestEarned
      ? RewardWorkflowState.ChestEligible
      : RewardWorkflowState.CreditConfirmed

    await this.workflows.findOneAndUpdate(
      { _id: id, state: RewardWorkflowState.PendingCredit },
      {
        $set: {
          state: nextState,
          balance: result.balance,
          victoryProgress: result.victoryProgress,
          weeklyChestCount: result.weeklyChestCount,
          chestEarned: result.chestEarned,
          updatedAt: new Date(),
        },
      },
    )

    return this.mustFind(id)
  }

  async applySelection(
    id: string,
    selection: RewardSelectionInput,
  ): Promise<RewardWorkflowSnapshot> {
    await this.workflows.findOneAndUpdate(
      { _id: id, state: RewardWorkflowState.ChestEligible },
      {
        $set: {
          state: RewardWorkflowState.RewardSelected,
          rewardProductId: selection.productId,
          rewardSku: selection.sku,
          rewardName: selection.name,
          inventoryOperationId: selection.inventoryOperationId,
          updatedAt: new Date(),
        },
      },
    )

    return this.mustFind(id)
  }

  async applyCompleted(id: string): Promise<RewardWorkflowSnapshot> {
    await this.workflows.findOneAndUpdate(
      { _id: id, state: { $in: [...COMPLETABLE_FROM] } },
      { $set: { state: RewardWorkflowState.Completed, updatedAt: new Date() } },
    )

    return this.mustFind(id)
  }

  async applyTerminalFailure(id: string, reason: string): Promise<RewardWorkflowSnapshot> {
    await this.workflows.findOneAndUpdate(
      { _id: id, state: { $in: [...NON_TERMINAL_STATES] } },
      {
        $set: {
          state: RewardWorkflowState.TerminalFailure,
          failureReason: reason,
          updatedAt: new Date(),
        },
      },
    )

    return this.mustFind(id)
  }

  async registerRetryableFailure(id: string, reason: string): Promise<void> {
    await this.workflows.updateOne(
      { _id: id },
      { $set: { failureReason: reason, updatedAt: new Date() }, $inc: { attempts: 1 } },
    )
  }

  private async mustFind(id: string): Promise<RewardWorkflowSnapshot> {
    const document = await this.workflows.findOne({ _id: id })

    if (document === null) {
      throw new Error(
        `RewardWorkflow "${id}" no existe tras una operacion que debia crearlo o leerlo.`,
      )
    }

    return toSnapshot(document)
  }
}

const toSnapshot = (document: RewardWorkflowDocument): RewardWorkflowSnapshot => {
  const state = document.state as RewardWorkflowState

  return {
    id: document._id,
    battleId: document.battleId,
    playerId: document.playerId,
    teamLabel: document.teamLabel,
    seat: document.seat,
    creditsAmount: document.creditsAmount,
    victoryCreditsAmount: document.victoryCreditsAmount,
    finishedAt: document.finishedAt,
    state,
    walletOperationId: document.walletOperationId,
    balance: document.balance,
    victoryProgress: document.victoryProgress,
    weeklyChestCount: document.weeklyChestCount,
    chestEarned: document.chestEarned,
    rewardProductId: document.rewardProductId,
    rewardSku: document.rewardSku,
    rewardName: document.rewardName,
    inventoryOperationId: document.inventoryOperationId,
    failureReason: document.failureReason,
    attempts: document.attempts,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }
}
