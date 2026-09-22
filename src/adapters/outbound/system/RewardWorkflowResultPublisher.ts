import type {
  BattleFinishedNotification,
  BattleResultPublisherPort,
} from '../../../application/ports/BattleResultPublisherPort'
import type { BattleRoomRepositoryPort } from '../../../application/ports/BattleRoomRepositoryPort'
import { StakeStatus } from '../../../domain/value-objects/ParticipantStake'
import type { StakeReleaser } from '../../../application/services/StakeReleaser'
import type { StakeSettler } from '../../../application/services/StakeSettler'
import type { CreateRewardWorkflows } from '../../../application/use-cases/CreateRewardWorkflows'
import type { ProcessRewardWorkflow } from '../../../application/use-cases/ProcessRewardWorkflow'
import type { Logger } from '../../../infrastructure/observability/logger'

/**
 * Adaptador de la señal a consumidores (HU-21, contrato §9) para HU-22 y HU-23.
 *
 * Conserva EXACTAMENTE el registro estructurado `battle_finished` de
 * `LoggingBattleResultPublisher` (minimizacion del contrato §11: solo
 * `roomId`, `reason`, `outcome`, `winnerTeamLabel`) y ADEMAS:
 *
 *  1. crea los `RewardWorkflow` de la batalla (HU-22) e intenta procesarlos
 *     de inmediato;
 *  2. liquida o libera las apuestas de la sala (HU-23): `WIN` -> `/settle`
 *     UNA vez por batalla (D10); `NO_WINNER` -> liberacion de todos los
 *     holds (D3). El reparto lo calcula `BattleStakePolicy`, nunca este
 *     adaptador.
 *
 * `publish()` sigue siendo SINCRONO (no reabre la firma de
 * `BattleResultPublisherPort`, que HU-21 ya cerro): ambos trabajos se lanzan
 * sin esperarlos ("fire and forget"), exactamente la semantica *al menos una
 * vez* que el contrato de HU-21 documenta -- un fallo se registra y NO
 * revierte la batalla. Los dos son INDEPENDIENTES: los creditos de HU-22
 * siguen su camino aunque la apuesta falle, y viceversa (cada uno con su
 * `try/catch`).
 *
 * La sala se relee del repositorio para conocer sus apuestas: la notificacion
 * de HU-21 no las lleva y su forma no se toca.
 */
export class RewardWorkflowResultPublisher implements BattleResultPublisherPort {
  constructor(
    private readonly createWorkflows: CreateRewardWorkflows,
    private readonly processWorkflow: ProcessRewardWorkflow,
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly stakeSettler: StakeSettler,
    private readonly stakeReleaser: StakeReleaser,
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

    void this.settleStakes(notification).catch((error: unknown) => {
      this.logger.error('stake_liquidacion_publicacion_fallo', {
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

  private async settleStakes(notification: BattleFinishedNotification): Promise<void> {
    const room = await this.rooms.findById(notification.roomId)

    if (room === null) {
      return
    }

    const hasActiveStakes = room.stakesAtRisk().some((stake) => stake.status === StakeStatus.Active)

    if (!hasActiveStakes) {
      return
    }

    if (room.result?.outcome === 'WIN') {
      this.stakeSettler.settle(room)
    } else {
      this.stakeReleaser.releaseAll(room, 'NO_WINNER')
    }
  }
}
