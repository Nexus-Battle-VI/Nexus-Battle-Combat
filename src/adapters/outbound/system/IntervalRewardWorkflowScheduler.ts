import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'

import type { ProcessRewardWorkflow } from '../../../application/use-cases/ProcessRewardWorkflow'
import type { ReconcileRewardWorkflows } from '../../../application/use-cases/ReconcileRewardWorkflows'
import type { RewardWorkflowRepositoryPort } from '../../../application/ports/RewardWorkflowRepositoryPort'
import type { Logger } from '../../../infrastructure/observability/logger'

export interface RewardWorkflowSchedulerOptions {
  readonly autoStart: boolean
  readonly tickMs: number
  /** Workflows por barrido. Acota el trabajo de un tick bajo carga. */
  readonly batchSize: number
  /**
   * Ventana de la reconciliacion de arranque (HU-22): cuantas horas hacia
   * atras se revisan las salas `FINISHED` en busca de un `RewardWorkflow`
   * que nunca se creo (ver `ReconcileRewardWorkflows`). Acotada a proposito:
   * no es un escaneo del historico completo, solo el margen razonable para
   * que una caida entre el fin de la batalla y la creacion del workflow no
   * pierda la recompensa para siempre.
   */
  readonly reconcileWindowMs: number
}

export const DEFAULT_REWARD_WORKFLOW_SCHEDULER_OPTIONS: RewardWorkflowSchedulerOptions = {
  autoStart: true,
  tickMs: 1_000,
  batchSize: 50,
  reconcileWindowMs: 24 * 60 * 60 * 1_000,
}

/**
 * Barrido del `RewardWorkflow` (HU-22, `hu-22-reward-contract-v1` §8), mismo
 * patron que `IntervalBattleDeadlineScheduler` (HU-21): cada `tickMs`
 * consulta los workflows NO terminales (persistidos, no una cola en
 * memoria -- HU-22 §68, "no depender de memory queue exclusivamente") y los
 * avanza uno por uno.
 *
 * Al ARRANCAR, ADEMAS, reconcilia las salas `FINISHED` recientes contra sus
 * workflows (`ReconcileRewardWorkflows`, HU-22): el barrido normal solo lee
 * workflows que YA existen, y `RewardWorkflowResultPublisher.publish()` los
 * crea fire-and-forget DESPUES de persistir la sala -- una caida justo en ese
 * hueco deja una sala `FINISHED` sin workflow, y nada mas la recuperaria. La
 * reconciliacion corre ANTES del barrido para que un workflow recreado en
 * esta misma pasada ya quede recogido por el `tick()` que sigue. Un workflow
 * que quedo a medias (creado, pero sin terminar) reanuda exactamente donde
 * estaba con el barrido normal (`ProcessRewardWorkflow.execute` es
 * idempotente y resumible en cualquier estado) -- no necesita reconciliacion.
 *
 * Un fallo en un workflow se registra y NO detiene a los demas.
 */
export class IntervalRewardWorkflowScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly options: RewardWorkflowSchedulerOptions
  private readonly inFlight = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly repository: RewardWorkflowRepositoryPort,
    private readonly process: ProcessRewardWorkflow,
    private readonly reconcile: ReconcileRewardWorkflows,
    private readonly logger: Logger,
    options: RewardWorkflowSchedulerOptions = DEFAULT_REWARD_WORKFLOW_SCHEDULER_OPTIONS,
  ) {
    this.options = options
  }

  async onApplicationBootstrap(): Promise<void> {
    const since = new Date(Date.now() - this.options.reconcileWindowMs)
    const roomsChecked = await this.reconcile.execute(since)

    this.logger.info('reward_workflows_reconciliados', { roomsChecked })

    const processed = await this.tick()

    this.logger.info('reward_workflows_recuperados', { processed })

    if (!this.options.autoStart) {
      return
    }

    this.timer = setInterval(() => {
      void this.tick()
    }, this.options.tickMs)
    this.timer.unref()
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<number> {
    const due = await this.repository.findNonTerminal(this.options.batchSize)
    let processed = 0

    for (const workflow of due) {
      if (this.inFlight.has(workflow.id)) {
        continue
      }

      this.inFlight.add(workflow.id)

      try {
        await this.process.execute(workflow.id)
        processed += 1
      } catch (error: unknown) {
        this.logger.error('reward_workflow_barrido_fallo', {
          workflowId: workflow.id,
          reason: error instanceof Error ? error.name : 'desconocido',
        })
      } finally {
        this.inFlight.delete(workflow.id)
      }
    }

    return processed
  }
}
