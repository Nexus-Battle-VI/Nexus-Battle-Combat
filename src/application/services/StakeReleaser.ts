import type { BattleRoom } from '../../domain/entities/BattleRoom'
import { StakeStatus, type StakeAtRisk } from '../../domain/value-objects/ParticipantStake'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { StakeReleaseReason, WalletStakePort } from '../ports/WalletStakePort'
import { stakeReleaseOperationIdOf } from './StakeOperationIds'

/** Lo unico que la liberacion necesita de un registro estructurado. */
export interface StakeReleaserLogger {
  error(message: string, context?: Readonly<Record<string, string>>): void
}

/**
 * Liberacion FIRE-AND-FORGET (HU-23, contrato §7): cancelar una sala o
 * abandonarla NUNCA debe fallar porque Wallet este caido. La intencion no se
 * persiste como estado propio: la sala queda CANCELLED (o el participante se
 * va) con su apuesta `ACTIVE`, y el barrido de recuperacion
 * (`ReconcileStakes`) la retoma. Mientras tanto, `ACTIVE` es la verdad: el
 * hold sigue reservado en Wallet.
 *
 * Al confirmar Wallet, el estado se marca en la MISMA escritura del agregado
 * (`RELEASED`). Un fallo se registra y se deja el estado como esta: nunca se
 * miente sobre lo que Wallet confirmo.
 */
export class StakeReleaser {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly wallet: WalletStakePort,
    private readonly logger: StakeReleaserLogger,
  ) {}

  /**
   * Libera cada hold `ACTIVE` de la sala. NO LANZA y NO ESPERA: la mutacion
   * de la sala ya esta persistida cuando se invoca (cancelacion), y la
   * liberacion es una consecuencia que se recupera aparte si falla.
   */
  releaseAll(room: BattleRoom, reason: StakeReleaseReason): void {
    const active = room.stakesAtRisk().filter((stake) => stake.status === StakeStatus.Active)

    if (active.length === 0) {
      return
    }

    void this.releaseConfirmed(room.id, active, reason).catch((error: unknown) => {
      this.logger.error('stake_liberacion_fallo', {
        battleId: room.id,
        reason: error instanceof Error ? error.name : 'desconocido',
      })
    })
  }

  /**
   * Libera la apuesta de un participante que ABANDONA la sala. No hay estado
   * que marcar despues: el participante ya no esta en la sala. Un fallo aqui
   * no tiene reintento propio (no queda rastro en el agregado): lo cubre la
   * expiracion de 24 h de D11 en Wallet.
   */
  releaseDeparted(
    battleId: string,
    playerId: string,
    holdOperationId: string,
    reason: StakeReleaseReason,
  ): void {
    void this.wallet
      .release({
        operationId: stakeReleaseOperationIdOf(battleId, playerId),
        holdId: holdOperationId,
        reason,
      })
      .catch((error: unknown) => {
        this.logger.error('stake_liberacion_abandono_fallo', {
          battleId,
          playerId,
          reason: error instanceof Error ? error.name : 'desconocido',
        })
      })
  }

  private async releaseConfirmed(
    battleId: string,
    stakes: readonly StakeAtRisk[],
    reason: StakeReleaseReason,
  ): Promise<void> {
    const confirmed: StakeAtRisk[] = []

    for (const stake of stakes) {
      try {
        await this.wallet.release({
          operationId: stakeReleaseOperationIdOf(battleId, stake.playerId),
          holdId: stake.holdOperationId,
          reason,
        })
        confirmed.push(stake)
      } catch (error: unknown) {
        this.logger.error('stake_liberacion_fallo', {
          battleId,
          playerId: stake.playerId,
          reason: error instanceof Error ? error.name : 'desconocido',
        })
      }
    }

    if (confirmed.length === 0) {
      return
    }

    const current = await this.rooms.findById(battleId)

    if (current === null) {
      return
    }

    const updated = current.withStakeStatuses(
      confirmed.map((stake) => ({
        holdOperationId: stake.holdOperationId,
        status: StakeStatus.Released,
      })),
    )

    await this.rooms.save(updated, current.version)
  }
}
