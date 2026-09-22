import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'

import type { ClockPort } from '../../../application/ports/ClockPort'
import type { ReconcileStakes } from '../../../application/use-cases/ReconcileStakes'
import type { Logger } from '../../../infrastructure/observability/logger'

export interface StakeSchedulerOptions {
  readonly autoStart: boolean
  readonly tickMs: number
}

export const DEFAULT_STAKE_SCHEDULER_OPTIONS: StakeSchedulerOptions = {
  autoStart: true,
  tickMs: 1_000,
}

/**
 * Barrido de recuperacion de apuestas (HU-23, contrato §7 y §9), mismo patron
 * que `IntervalRewardWorkflowScheduler` de HU-22: al ARRANCAR reconcilia las
 * salas terminales recientes con apuestas pendientes (una caida entre
 * persistir el resultado/cancelacion y confirmar con Wallet no puede dejar el
 * hold bloqueado hasta su expiracion), y despues revisa periodicamente.
 *
 * Los reintentos son seguros por construccion: los `operationId` son
 * deterministas y Wallet reconoce el replay. Un fallo del barrido se registra
 * y no detiene el proceso.
 */
export class IntervalStakeScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly options: StakeSchedulerOptions
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly reconcile: ReconcileStakes,
    private readonly clock: ClockPort,
    private readonly logger: Logger,
    options: StakeSchedulerOptions = DEFAULT_STAKE_SCHEDULER_OPTIONS,
  ) {
    this.options = options
  }

  async onApplicationBootstrap(): Promise<void> {
    const retaken = await this.tick()

    this.logger.info('stakes_reconciliados', { retaken })

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
    try {
      return await this.reconcile.execute()
    } catch (error: unknown) {
      this.logger.error('stake_reconciliacion_fallo', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })

      return 0
    }
  }
}
