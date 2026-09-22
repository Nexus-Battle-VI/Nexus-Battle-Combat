import type { BattleRoom } from '../../domain/entities/BattleRoom'
import { StakeStatus, type StakeAtRisk } from '../../domain/value-objects/ParticipantStake'
import type { ClockPort } from '../ports/ClockPort'
import type { WalletStakePort } from '../ports/WalletStakePort'
import { stakeReleaseOperationIdOf } from './StakeOperationIds'

/** Lo unico que la reserva necesita de un registro estructurado. */
export interface StakeReserverLogger {
  error(message: string, context?: Readonly<Record<string, string>>): void
}

/**
 * Reserva SINCRONA (D8) de las apuestas de un `create`/`join`, ANTES de
 * persistir la sala. Wallet es la unica autoridad del disponible: si rechaza
 * (`INSUFFICIENT_AVAILABLE_BALANCE`), el caso de uso completo falla y NADA se
 * persiste.
 *
 * La sala entra con las apuestas `PENDING_RESERVE` (el agregado aun no sabe
 * si Wallet aceptara) y sale con `ACTIVE` solo cuando TODAS se confirmaron.
 * Si una falla despues de que otra se confirmo, se compensa liberando las ya
 * reservadas -- en la practica un `create`/`join` tiene a lo sumo UNA apuesta
 * (un solo HUMANO por operacion), pero la compensacion deja la regla correcta
 * sin depender de ese limite.
 */
export class StakeReserver {
  constructor(
    private readonly wallet: WalletStakePort,
    private readonly clock: ClockPort,
    private readonly logger: StakeReserverLogger,
  ) {}

  async reservePending(room: BattleRoom): Promise<BattleRoom> {
    const pending = room
      .stakesAtRisk()
      .filter((stake) => stake.status === StakeStatus.PendingReserve)

    if (pending.length === 0) {
      return room
    }

    const occurredAt = this.clock.now()
    const reserved: StakeAtRisk[] = []

    try {
      for (const stake of pending) {
        await this.wallet.reserve({
          operationId: stake.holdOperationId,
          playerId: stake.playerId,
          battleId: room.id,
          amount: stake.amount,
          occurredAt,
        })
        reserved.push(stake)
      }
    } catch (error: unknown) {
      await this.compensate(room.id, reserved)
      throw error
    }

    return room.withStakesActivated()
  }

  private async compensate(battleId: string, reserved: readonly StakeAtRisk[]): Promise<void> {
    for (const stake of reserved) {
      try {
        await this.wallet.release({
          operationId: stakeReleaseOperationIdOf(battleId, stake.playerId),
          holdId: stake.holdOperationId,
          reason: 'ROOM_CANCELLED',
        })
      } catch (error: unknown) {
        this.logger.error('stake_reserva_compensacion_fallo', {
          battleId,
          playerId: stake.playerId,
          reason: error instanceof Error ? error.name : 'desconocido',
        })
      }
    }
  }
}
