import type {
  BattleFinishedNotification,
  BattleResultPublisherPort,
} from '../../../application/ports/BattleResultPublisherPort'
import type { CreateRewardWorkflows } from '../../../application/use-cases/CreateRewardWorkflows'
import type { ProcessRewardWorkflow } from '../../../application/use-cases/ProcessRewardWorkflow'
import type { Logger } from '../../../infrastructure/observability/logger'

/**
 * Adaptador de la señal a consumidores (HU-21, contrato §9) para HU-22.
 *
 * Conserva EXACTAMENTE el registro estructurado `battle_finished` de
 * `LoggingBattleResultPublisher` (minimizacion del contrato §11: solo
 * `roomId`, `reason`, `outcome`, `winnerTeamLabel`) y ADEMAS crea los
 * `RewardWorkflow` de la batalla e intenta procesarlos de inmediato.
 *
 * `publish()` sigue siendo SINCRONO (no reabre la firma de
 * `BattleResultPublisherPort`, que HU-21 ya cerro): el trabajo de HU-22 se
 * lanza sin esperarlo ("fire and forget"), exactamente la semantica *al
 * menos una vez* que el contrato de HU-21 ya documenta -- un fallo se
 * registra y NO revierte la batalla. Si el intento inmediato no completa
 * (Wallet/Inventory caidos, por ejemplo), `IntervalRewardWorkflowScheduler`
 * lo recoge en el siguiente barrido: la creacion en si (`createIfAbsent`,
 * persistida) es lo unico que debe sobrevivir a este metodo, y sucede antes
 * de intentar procesar nada.
 */
export class RewardWorkflowResultPublisher implements BattleResultPublisherPort {
  constructor(
    private readonly createWorkflows: CreateRewardWorkflows,
    private readonly processWorkflow: ProcessRewardWorkflow,
    private readonly logger: Logger,
  ) {}

  publish(notification: BattleFinishedNotification): void {
    this.logger.info('battle_finished', {
      roomId: notification.roomId,
      reason: notification.reason,
      outcome: notification.outcome,
      winnerTeamLabel: notification.winnerTeamLabel,
    })

    void this.createAndProcess(notification).catch((error: unknown) => {
      this.logger.error('reward_workflows_creacion_fallo', {
        roomId: notification.roomId,
        reason: error instanceof Error ? error.name : 'desconocido',
      })
    })
  }

  private async createAndProcess(notification: BattleFinishedNotification): Promise<void> {
    const workflows = await this.createWorkflows.execute(notification)

    await Promise.all(
      workflows.map((workflow) =>
        this.processWorkflow.execute(workflow.id).catch((error: unknown) => {
          this.logger.error('reward_workflow_procesamiento_inmediato_fallo', {
            workflowId: workflow.id,
            reason: error instanceof Error ? error.name : 'desconocido',
          })
        }),
      ),
    )
  }
}
