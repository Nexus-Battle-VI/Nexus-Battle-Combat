import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'

import type { ProcessRewardWorkflow } from '../../../application/use-cases/ProcessRewardWorkflow'
import type { RewardWorkflowRepositoryPort } from '../../../application/ports/RewardWorkflowRepositoryPort'
import type { Logger } from '../../../infrastructure/observability/logger'

export interface RewardWorkflowSchedulerOptions {
  readonly autoStart: boolean
  readonly tickMs: number
  /** Workflows por barrido. Acota el trabajo de un tick bajo carga. */
  readonly batchSize: number
}

export const DEFAULT_REWARD_WORKFLOW_SCHEDULER_OPTIONS: RewardWorkflowSchedulerOptions = {
  autoStart: true,
  tickMs: 1_000,
  batchSize: 50,
}

/**
 * Barrido del `RewardWorkflow` (HU-22, `hu-22-reward-contract-v1` §8), mismo
 * patron que `IntervalBattleDeadlineScheduler` (HU-21): cada `tickMs`
 * consulta los workflows NO terminales (persistidos, no una cola en
 * memoria -- HU-22 §68, "no depender de memory queue exclusivamente") y los
 * avanza uno por uno.
 *
 * Al ARRANCAR procesa un barrido inmediato: no hace falta un caso de uso de
 * "recuperacion" aparte, porque este barrido YA consulta el estado
 * persistido en cada tick, incluido el primero tras un reinicio. Un
 * workflow que quedo a medias reanuda exactamente donde estaba
 * (`ProcessRewardWorkflow.execute` es idempotente y resumible en cualquier
 * estado).
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
    private readonly logger: Logger,
    options: RewardWorkflowSchedulerOptions = DEFAULT_REWARD_WORKFLOW_SCHEDULER_OPTIONS,
  ) {
    this.options = options
  }

  async onApplicationBootstrap(): Promise<void> {
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
