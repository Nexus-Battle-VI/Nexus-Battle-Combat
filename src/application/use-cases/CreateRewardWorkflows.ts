import { ParticipantResultKind } from '../../domain/entities/BattleResult'
import type { BattleFinishedNotification } from '../ports/BattleResultPublisherPort'
import type {
  RewardWorkflowIntent,
  RewardWorkflowRepositoryPort,
  RewardWorkflowSnapshot,
} from '../ports/RewardWorkflowRepositoryPort'

/** `operationId` determinista de Wallet: mismo battle+player siempre produce el mismo. */
export const walletOperationIdOf = (battleId: string, playerId: string): string =>
  `battle:${battleId}:player:${playerId}:credit`

/** `operationId` determinista de Player-Inventory. Secuencia siempre 1: un cofre entrega un unico item (HU-22). */
export const inventoryOperationIdOf = (battleId: string, playerId: string): string =>
  `battle:${battleId}:player:${playerId}:chest:1:grant`

/**
 * Task HU-22.3. Crea el `RewardWorkflow` de cada participante HUMANO de una
 * batalla terminada (`hu-22-reward-contract-v1` §8, estado inicial
 * `PENDING_CREDIT`), a partir de `BattleFinishedNotification` (HU-21, §9).
 *
 * NO reimplementa `BattleCreditsPolicy`: consume `credits` tal como HU-21 ya
 * lo calculo. Un participante `AI` (`credits: null`) no genera workflow -- no
 * tiene cuenta de Wallet.
 *
 * Idempotente por `createIfAbsent`: una notificacion repetida (HU-21, §9,
 * "al menos una vez") no crea un segundo workflow para el mismo battle+player.
 */
export class CreateRewardWorkflows {
  constructor(private readonly repository: RewardWorkflowRepositoryPort) {}

  async execute(
    notification: BattleFinishedNotification,
  ): Promise<readonly RewardWorkflowSnapshot[]> {
    const created: RewardWorkflowSnapshot[] = []

    for (const participant of notification.participants) {
      if (participant.playerId === null || participant.credits === null) {
        continue
      }

      const victoryCreditsAmount =
        participant.result === ParticipantResultKind.Won ? participant.credits : 0

      const intent: RewardWorkflowIntent = {
        battleId: notification.roomId,
        playerId: participant.playerId,
        teamLabel: participant.teamLabel,
        seat: participant.seat,
        creditsAmount: participant.credits,
        victoryCreditsAmount,
        finishedAt: new Date(notification.finishedAt),
      }

      const workflow = await this.repository.createIfAbsent(
        intent,
        walletOperationIdOf(notification.roomId, participant.playerId),
      )

      created.push(workflow)
    }

    return created
  }
}
