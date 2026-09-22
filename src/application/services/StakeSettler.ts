import type { BattleRoom } from '../../domain/entities/BattleRoom'
import { stakeSettlementFor } from '../../domain/policies/BattleStakePolicy'
import { StakeStatus } from '../../domain/value-objects/ParticipantStake'
import { StakeOperationConflictError, StakeRejectedError } from '../errors/StakeIntegrationErrors'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { WalletStakePort } from '../ports/WalletStakePort'
import type { StakeReleaser } from './StakeReleaser'
import { stakeSettleOperationIdOf } from './StakeOperationIds'

/** Lo unico que la liquidacion necesita de un registro estructurado. */
export interface StakeSettlerLogger {
  error(message: string, context?: Readonly<Record<string, string>>): void
}

/**
 * Liquidacion de una batalla con ganador (HU-23, contrato §5.3 y §7):
 * `BattleStakePolicy` calcula el reparto y se envia a Wallet en UNA sola
 * llamada por batalla (D10). FIRE-AND-FORGET, mismo criterio que
 * `RewardWorkflowResultPublisher`: la batalla ya esta persistida y difundida,
 * un fallo de Wallet se reintenta con el barrido de recuperacion
 * (`ReconcileStakes`) y NUNCA revierte `battleFinished`.
 *
 * Al confirmar Wallet, cada hold se marca `CAPTURED`/`SETTLED_WON` en la misma
 * escritura del agregado. Un rechazo terminal (409/422) es un bug de la
 * politica, no un fallo transitorio (contrato §9): se registra UNA vez y no se
 * reintenta solo dentro de este proceso -- la expiracion de 24 h de D11 es la
 * red de seguridad que devuelve el disponible si nadie lo arregla.
 */
export class StakeSettler {
  private readonly terminalFailures = new Set<string>()

  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly wallet: WalletStakePort,
    private readonly releaser: StakeReleaser,
    private readonly logger: StakeSettlerLogger,
  ) {}

  /** NO LANZA y NO ESPERA: la liquidacion es una consecuencia posterior al resultado. */
  settle(room: BattleRoom): void {
    if (this.terminalFailures.has(room.id)) {
      return
    }

    void this.settleConfirmed(room).catch((error: unknown) => {
      this.logger.error('stake_liquidacion_fallo', {
        battleId: room.id,
        reason: error instanceof Error ? error.name : 'desconocido',
      })
    })
  }

  private async settleConfirmed(room: BattleRoom): Promise<void> {
    const result = room.result

    if (result === null) {
      return
    }

    const active = room.stakesAtRisk().filter((stake) => stake.status === StakeStatus.Active)

    if (active.length === 0) {
      return
    }

    const settlement = stakeSettlementFor(result, active)

    if (settlement === null) {
      // Sin ganador con apuesta no hay destinatario para el pozo: se libera
      // todo en vez de capturar sin contrapartida (Wallet exige suma cero).
      this.releaser.releaseAll(room, 'NO_WINNER')
      return
    }

    try {
      await this.wallet.settle({
        operationId: stakeSettleOperationIdOf(room.id),
        battleId: room.id,
        settlements: settlement.entries,
      })
    } catch (error: unknown) {
      if (error instanceof StakeRejectedError || error instanceof StakeOperationConflictError) {
        this.terminalFailures.add(room.id)
        this.logger.error('stake_liquidacion_rechazo_terminal', {
          battleId: room.id,
          reason: error instanceof Error ? error.name : 'desconocido',
          code: error instanceof StakeRejectedError ? (error.code ?? 'sin_codigo') : 'conflicto',
        })
        return
      }

      throw error
    }

    const current = await this.rooms.findById(room.id)

    if (current === null) {
      return
    }

    const updated = current.withStakeStatuses(
      settlement.entries.map((entry) => ({
        holdOperationId: entry.holdId,
        status: entry.outcome === 'CAPTURED' ? StakeStatus.Captured : StakeStatus.SettledWon,
      })),
    )

    await this.rooms.save(updated, current.version)
  }
}
