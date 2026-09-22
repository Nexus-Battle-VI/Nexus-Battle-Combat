import type {
  BattleFinishedNotification,
  BattleResultPublisherPort,
} from '../../../application/ports/BattleResultPublisherPort'
import type { Logger } from '../../../infrastructure/observability/logger'

/**
 * Adaptador de la senal a consumidores para ESTA historia (HU-21, contrato §9):
 * escribe UN registro estructurado `battle_finished` y nada mas.
 *
 * No hay transporte entre servicios todavia: el de HU-22 (cofre), HU-23
 * (apuesta), HU-30 (caida de items), HU-29 (liberacion del equipamiento) y
 * HU-09 (experiencia) es una decision de esas historias con Infrastructure.
 *
 * MINIMIZACION (contrato §11): solo `roomId`, `reason`, `outcome` y
 * `winnerTeamLabel`; NUNCA nombres de jugador, `playerId` ni creditos por
 * jugador. El registro es la traza de que la señal salio; la entrega real no
 * ocurre aqui.
 */
export class LoggingBattleResultPublisher implements BattleResultPublisherPort {
  constructor(private readonly logger: Logger) {}

  publish(notification: BattleFinishedNotification): void {
    this.logger.info('battle_finished', {
      roomId: notification.roomId,
      reason: notification.reason,
      outcome: notification.outcome,
      winnerTeamLabel: notification.winnerTeamLabel,
    })
  }
}
