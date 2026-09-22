import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'

import type { BattleDeadlineBookPort } from '../../../application/ports/BattleDeadlineBookPort'
import type { ClockPort } from '../../../application/ports/ClockPort'
import type { ProcessBattleDeadlines } from '../../../application/use-cases/ProcessBattleDeadlines'
import type { RecoverBattleDeadlines } from '../../../application/use-cases/RecoverBattleDeadlines'
import type { Logger } from '../../../infrastructure/observability/logger'

/** Opciones del barrido: en pruebas `autoStart: false` y el reloj se mueve a mano. */
export interface BattleDeadlineSchedulerOptions {
  readonly autoStart: boolean
  readonly tickMs: number
}

export const DEFAULT_BATTLE_DEADLINE_SCHEDULER_OPTIONS: BattleDeadlineSchedulerOptions = {
  autoStart: true,
  tickMs: 1_000,
}

/**
 * Barrido de vencimientos (HU-21, contrato §3): cada segundo revisa el libro y
 * procesa las salas vencidas, cada una bajo su cerrojo (`ProcessBattleDeadlines`).
 *
 *  - Al arrancar (`bootstrap`) RECUPERA las salas `IN_BATTLE`: los vencimientos
 *    globales y de turno son derivables del estado persistido y sobreviven al
 *    reinicio; la gracia de todos los participantes empieza AHI.
 *  - `tick()` es PUBLICO para que las pruebas lo muevan sin temporizadores
 *    reales (con `autoStart: false` no hay ni uno).
 *  - Un fallo en una sala se registra y NO detiene a las demas.
 *  - Es el UNICO archivo nuevo con `setInterval`: el reloj del barrido es este,
 *    no el de las reglas de combate (esas usan `ClockPort`).
 */
export class IntervalBattleDeadlineScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly options: BattleDeadlineSchedulerOptions
  private readonly inFlight = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly book: BattleDeadlineBookPort,
    private readonly process: ProcessBattleDeadlines,
    private readonly recover: RecoverBattleDeadlines,
    private readonly clock: ClockPort,
    private readonly logger: Logger,
    options: BattleDeadlineSchedulerOptions = DEFAULT_BATTLE_DEADLINE_SCHEDULER_OPTIONS,
  ) {
    this.options = options
  }

  async onApplicationBootstrap(): Promise<void> {
    const recovered = await this.recover.execute()

    this.logger.info('battle_deadlines_recuperados', { rooms: recovered })

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

  /**
   * Procesa las salas vencidas AHORA. Devuelve cuantas proceso. Antes de
   * procesar cada una, adelanta su vencimiento un tick: si el trabajo se alarga,
   * el siguiente barrido no la vuelve a tomar por el mismo vencimiento ya
   * atendido (el `Settler` reprograma el real al terminar).
   */
  async tick(): Promise<number> {
    const now = this.clock.now()
    const due = this.book.dueRooms(now)
    let processed = 0

    for (const roomId of due) {
      if (this.inFlight.has(roomId)) {
        continue
      }

      this.inFlight.add(roomId)
      this.book.setDue(roomId, new Date(now.getTime() + this.options.tickMs))

      try {
        await this.process.execute(roomId)
        processed += 1
      } catch (error: unknown) {
        this.logger.error('battle_deadline_fallo', {
          roomId,
          reason: error instanceof Error ? error.name : 'desconocido',
        })
      } finally {
        this.inFlight.delete(roomId)
      }
    }

    return processed
  }
}
