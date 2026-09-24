import { buildBattleFinishedNotification } from '../services/BattleFinalizer'
import type { BattleHeroCommitmentPort } from '../ports/BattleHeroCommitmentPort'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { CreateRewardWorkflows } from './CreateRewardWorkflows'

/** Lo unico que el reconciliador necesita de un registro estructurado. */
export interface ReconcileRewardWorkflowsLogger {
  error(message: string, context?: Readonly<Record<string, string>>): void
}

/**
 * Cierra la ventana entre "sala FINISHED persistida" y "RewardWorkflow
 * persistido" (HU-22). `RewardWorkflowResultPublisher.publish()` es
 * fire-and-forget POR CONTRATO (`BattleResultPublisherPort`, cerrado por
 * HU-21, no puede volverse asincrono): crea los workflows *despues* de que
 * `afterFinished` ya escribio la sala, sin esperar esa creacion. Si el
 * proceso muere justo en ese hueco, ningun `RewardWorkflow` llega a existir
 * para esa batalla, y `IntervalRewardWorkflowScheduler.tick()` no tiene nada
 * que recuperar: solo lee workflows que YA existen (`findNonTerminal`).
 *
 * Al arrancar, se reconcilian las salas `FINISHED` recientes (ventana
 * acotada, no el historico completo) contra sus workflows:
 * `CreateRewardWorkflows.execute` es idempotente por participante
 * (`createIfAbsent`), asi que una sala cuyos workflows ya existen es un
 * no-op para cada uno de ellos -- reconciliar no puede duplicar nada.
 */
export class ReconcileRewardWorkflows {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly createWorkflows: CreateRewardWorkflows,
    private readonly commitments: BattleHeroCommitmentPort,
    private readonly logger: ReconcileRewardWorkflowsLogger,
  ) {}

  /** Devuelve cuantas salas `FINISHED` de la ventana se revisaron. */
  async execute(since: Date): Promise<number> {
    const finished = await this.rooms.findFinishedSince(since)

    for (const room of finished) {
      const notification = buildBattleFinishedNotification(room)

      if (notification === null) {
        continue
      }

      // HU-29: la liberacion del compromiso tambien se reintenta aqui. Es el
      // MISMO hueco que los workflows -- `afterFinished` la dispara sin esperar y
      // el proceso puede morir antes de que llegue -- y la liberacion es
      // idempotente por contrato, asi que reintentarla no puede hacer dano.
      await this.releaseCommitments(room.id, notification.participants)

      try {
        await this.createWorkflows.execute(notification)
      } catch (error: unknown) {
        this.logger.error('reward_workflow_reconciliacion_fallo', {
          roomId: room.id,
          reason: error instanceof Error ? error.name : 'desconocido',
        })
      }
    }

    return finished.length
  }

  private async releaseCommitments(
    roomId: string,
    participants: readonly { readonly playerId: string | null }[],
  ): Promise<void> {
    const playerIds = [
      ...new Set(
        participants.flatMap((participant) =>
          participant.playerId === null ? [] : [participant.playerId],
        ),
      ),
    ]

    for (const playerId of playerIds) {
      try {
        await this.commitments.release(roomId, playerId)
      } catch (error: unknown) {
        this.logger.error('battle_commitment_reconciliacion_fallo', {
          roomId,
          playerId,
          reason: error instanceof Error ? error.name : 'desconocido',
        })
      }
    }
  }
}
