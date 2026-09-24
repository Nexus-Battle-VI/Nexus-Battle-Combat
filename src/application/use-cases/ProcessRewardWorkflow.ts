import { inventoryOperationIdOf } from './CreateRewardWorkflows'
import {
  RewardOperationConflictError,
  RewardRejectedError,
} from '../errors/RewardIntegrationErrors'
import { UpstreamServiceError } from '../errors/UpstreamErrors'
import type { ClockPort } from '../ports/ClockPort'
import type { RewardCreditPort } from '../ports/RewardCreditPort'
import type { RewardGrantPort } from '../ports/RewardGrantPort'
import type {
  RewardWorkflowRepositoryPort,
  RewardWorkflowSnapshot,
} from '../ports/RewardWorkflowRepositoryPort'
import type { RandomSequencePort } from '../ports/RandomSequencePort'
import {
  DEFAULT_REWARD_RETRY_POLICY,
  isRewardRetryDue,
  isRewardRetryExhausted,
  type RewardRetryPolicy,
} from '../services/RewardRetryPolicy'
import { RandomIndex } from '../../domain/value-objects/RandomIndex'
import {
  isTerminalRewardWorkflowState,
  RewardWorkflowState,
} from '../../domain/value-objects/RewardWorkflowState'
import type { RewardTable } from '../../domain/reward/RewardTable'

export interface ProcessRewardWorkflowLogger {
  info(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
  error(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
}

/**
 * Task HU-22.3. Avanza UN `RewardWorkflow` (`hu-22-reward-contract-v1` §8),
 * un paso por estado, hasta un estado terminal o hasta que un intento falle
 * de forma transitoria (el siguiente barrido lo recoge, HU-22 §68: "no
 * depender de memory queue exclusivamente").
 *
 * REUTILIZA `BATTLE_RANDOM_SEQUENCE` (la MISMA secuencia de proceso que
 * consumen la cola de turnos y los golpes, HU-17/18/19/24): no crea un
 * generador nuevo ni una secuencia por workflow.
 *
 * NINGÚN paso revierte un credito ya acreditado por Wallet (HU-22 §66): un
 * fallo despues de `CREDIT_CONFIRMED`/`CHEST_ELIGIBLE` deja el saldo firme y
 * solo la entrega del cofre queda pendiente o fallida.
 *
 * REINTENTOS ACOTADOS (`RewardRetryPolicy`): un fallo transitorio no se
 * reintenta en el siguiente segundo sino tras una espera que se duplica hasta
 * un techo, y agotado el tope de fallos el workflow pasa a `TERMINAL_FAILURE`
 * (visible como `rewardDelivery: FAILED`) en vez de reintentarse sin fin. Un
 * rechazo PERMANENTE (`RewardRejectedError`, incluido `RewardInvalidRequestError`)
 * no se reintenta nunca.
 */
export class ProcessRewardWorkflow {
  constructor(
    private readonly repository: RewardWorkflowRepositoryPort,
    private readonly creditPort: RewardCreditPort,
    private readonly grantPort: RewardGrantPort,
    private readonly sequence: RandomSequencePort,
    private readonly rewardTable: RewardTable,
    private readonly logger: ProcessRewardWorkflowLogger,
    private readonly clock: ClockPort,
    private readonly retryPolicy: RewardRetryPolicy = DEFAULT_REWARD_RETRY_POLICY,
  ) {}

  async execute(id: string): Promise<void> {
    let workflow = await this.repository.findById(id)

    if (
      workflow !== null &&
      !isTerminalRewardWorkflowState(workflow.state) &&
      !isRewardRetryDue(this.retryPolicy, workflow, this.clock.now())
    ) {
      // Sigue esperando desde su ultimo fallo transitorio: el barrido lo vera
      // otra vez cuando venza la espera.
      return
    }

    while (workflow !== null && !isTerminalRewardWorkflowState(workflow.state)) {
      const before = workflow.state
      workflow = await this.advance(workflow)

      if (workflow.state === before) {
        // Sin progreso: el intento de este paso fallo de forma transitoria y
        // ya quedo registrado. Se deja para el siguiente barrido.
        return
      }
    }
  }

  private async advance(workflow: RewardWorkflowSnapshot): Promise<RewardWorkflowSnapshot> {
    switch (workflow.state) {
      case RewardWorkflowState.PendingCredit:
        return this.callWallet(workflow)
      case RewardWorkflowState.CreditConfirmed:
        return this.repository.applyCompleted(workflow.id)
      case RewardWorkflowState.ChestEligible:
        return this.selectReward(workflow)
      case RewardWorkflowState.RewardSelected:
        return this.callInventory(workflow)
      default:
        return workflow
    }
  }

  private async callWallet(workflow: RewardWorkflowSnapshot): Promise<RewardWorkflowSnapshot> {
    try {
      const result = await this.creditPort.creditBattleReward({
        operationId: workflow.walletOperationId,
        playerId: workflow.playerId,
        battleId: workflow.battleId,
        creditsAmount: workflow.creditsAmount,
        victoryCreditsAmount: workflow.victoryCreditsAmount,
        occurredAt: workflow.finishedAt,
      })

      return await this.repository.applyWalletResult(workflow.id, {
        balance: result.balance,
        victoryProgress: result.victoryProgress,
        weeklyChestCount: result.weeklyChestCount,
        chestEarned: result.chestEarned,
      })
    } catch (error: unknown) {
      return this.handleFailure(workflow, 'wallet', error)
    }
  }

  /** Sortea con la secuencia compartida de proceso: UN indice por cofre elegible. */
  private async selectReward(workflow: RewardWorkflowSnapshot): Promise<RewardWorkflowSnapshot> {
    const index = this.sequence.nextIndex()
    const entry = this.rewardTable.resolve(index)

    return this.repository.applySelection(workflow.id, {
      productId: entry.productId,
      sku: entry.sku,
      name: entry.name,
      inventoryOperationId: inventoryOperationIdOf(workflow.battleId, workflow.playerId),
    })
  }

  private async callInventory(workflow: RewardWorkflowSnapshot): Promise<RewardWorkflowSnapshot> {
    if (workflow.rewardProductId === null || workflow.inventoryOperationId === null) {
      // Inalcanzable por construccion: `applySelection` siempre los persiste
      // juntos antes de que el workflow llegue a `REWARD_SELECTED`.
      return this.repository.applyTerminalFailure(
        workflow.id,
        'REWARD_SELECTED sin producto ni operationId de inventario persistidos.',
      )
    }

    try {
      await this.grantPort.grant({
        operationId: workflow.inventoryOperationId,
        playerId: workflow.playerId,
        productId: workflow.rewardProductId,
        quantity: 1,
      })

      return await this.repository.applyCompleted(workflow.id)
    } catch (error: unknown) {
      return this.handleFailure(workflow, 'inventory', error)
    }
  }

  private async handleFailure(
    workflow: RewardWorkflowSnapshot,
    stage: 'wallet' | 'inventory',
    error: unknown,
  ): Promise<RewardWorkflowSnapshot> {
    if (error instanceof RewardRejectedError || error instanceof RewardOperationConflictError) {
      this.logger.error('reward_workflow_fallo_terminal', {
        workflowId: workflow.id,
        stage,
        reason: error.name,
      })

      return this.repository.applyTerminalFailure(workflow.id, `${stage}: ${error.message}`)
    }

    const reason = error instanceof UpstreamServiceError ? error.reason : 'desconocido'

    this.logger.error('reward_workflow_fallo_transitorio', {
      workflowId: workflow.id,
      stage,
      reason,
    })

    await this.repository.registerRetryableFailure(workflow.id, `${stage}: ${reason}`)

    const attempts = workflow.attempts + 1

    if (isRewardRetryExhausted(this.retryPolicy, attempts)) {
      this.logger.error('reward_workflow_reintentos_agotados', {
        workflowId: workflow.id,
        stage,
        reason,
        attempts,
      })

      return this.repository.applyTerminalFailure(
        workflow.id,
        `${stage}: ${reason} (reintentos agotados tras ${String(attempts)} fallos)`,
      )
    }

    return workflow
  }
}

/** Verificacion de dominio: `RandomIndex.MAX` debe seguir siendo el espacio de la reward table. */
export const assertRewardTableSpace = (rows: number): void => {
  if (rows !== RandomIndex.MAX) {
    throw new Error(
      `La reward table debe cubrir exactamente RandomIndex.MAX (${String(RandomIndex.MAX)}), tiene ${String(rows)}.`,
    )
  }
}
