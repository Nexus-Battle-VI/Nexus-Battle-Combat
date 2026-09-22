import { StakeStatus } from '../../domain/value-objects/ParticipantStake'
import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { StakeReleaser } from '../services/StakeReleaser'
import type { StakeSettler } from '../services/StakeSettler'

/**
 * Ventana de reconciliacion (HU-23, mismo criterio que
 * `ReconcileRewardWorkflows` de HU-22): no es un escaneo del historico, es el
 * margen razonable para que una caida entre el final de la batalla (o la
 * cancelacion) y la liberacion/liquidacion no deje el hold bloqueado hasta su
 * expiracion de 24 h (D11). Cualquier apuesta `ACTIVE` de una sala terminal
 * fue reservada hace menos de 24 h (su hold ya habria expirado), asi que la
 * ventana cubre el caso real.
 */
export const STAKE_RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1_000

const hasActiveStake = (room: BattleRoom): boolean =>
  room.stakesAtRisk().some((stake) => stake.status === StakeStatus.Active)

/**
 * Recuperacion de apuestas al arrancar (HU-23, contrato §7 y §9): completa la
 * liberacion/liquidacion que quedo pendiente porque el proceso murio entre
 * persistir la sala terminal y confirmar con Wallet.
 *
 * El estado persistido es la intencion (contrato §9): una sala `FINISHED` con
 * un stake `ACTIVE` esta pendiente de liquidar (con ganador) o liberar
 * (`NO_WINNER`); una `CANCELLED` con un stake `ACTIVE`, pendiente de liberar.
 * Los `operationId` deterministas hacen que reintentar sea seguro: Wallet
 * reconoce el replay y no duplica nada.
 *
 * No hace falta reconciliar una sala `WAITING_FOR_PLAYERS`/`PREPARING`/
 * `IN_BATTLE`: ahi un stake `ACTIVE` es el estado normal (la batalla no ha
 * terminado).
 */
export class ReconcileStakes {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly settler: StakeSettler,
    private readonly releaser: StakeReleaser,
    private readonly clock: ClockPort,
    private readonly windowMs: number = STAKE_RECONCILE_WINDOW_MS,
  ) {}

  /** Devuelve cuantas salas terminales con apuestas pendientes se retomaron. */
  async execute(): Promise<number> {
    const since = new Date(this.clock.now().getTime() - this.windowMs)
    const finished = await this.rooms.findFinishedSince(since)
    const cancelled = await this.rooms.findCancelledSince(since)
    let retaken = 0

    for (const room of finished) {
      if (!hasActiveStake(room)) {
        continue
      }

      retaken += 1

      if (room.result?.outcome === 'WIN') {
        this.settler.settle(room)
      } else {
        this.releaser.releaseAll(room, 'NO_WINNER')
      }
    }

    for (const room of cancelled) {
      if (!hasActiveStake(room)) {
        continue
      }

      retaken += 1
      this.releaser.releaseAll(room, 'ROOM_CANCELLED')
    }

    return retaken
  }
}
