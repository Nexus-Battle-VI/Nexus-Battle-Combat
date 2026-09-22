import { RoomNotFoundError } from '../errors/ApplicationError'
import { StakeStatus } from '../../domain/value-objects/ParticipantStake'
import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { StakeReleaser } from '../services/StakeReleaser'

/**
 * Un participante abandona una sala de batalla (ciclo de vida del lobby,
 * HU-15.2): libera su propio cupo. Aplica igual al propietario que a
 * cualquier otro participante -- distinto de `CancelBattleRoom`, que es
 * exclusivo de `createdBy` y afecta a la sala entera.
 *
 * La precondicion "no se puede abandonar una sala CANCELLED" y "quien pide
 * debe ser participante HUMAN" las aplica `BattleRoom.leave()` (dominio);
 * este caso de uso solo resuelve la busqueda, delega la transicion y
 * persiste con el bloqueo optimista de la version leida -- mismo patron que
 * `CancelBattleRoom`.
 *
 * HU-23 (§7, D6): abandonar libera SOLO la apuesta de quien se va, aunque la
 * sala siga existiendo. La apuesta se captura ANTES de `leave()` (despues el
 * participante ya no esta en el agregado) y la liberacion es fire-and-forget:
 * abandonar NUNCA falla porque Wallet este caido. Sin reintento propio (el
 * rastro en la sala se fue con el participante): lo cubre la expiracion de
 * 24 h de D11.
 */
export class LeaveBattleRoom {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly releaser: StakeReleaser,
  ) {}

  async execute(roomId: string, playerId: string): Promise<BattleRoomDto> {
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    const stake = room.stakeOf(playerId)
    const left = room.leave(playerId)
    const saved = await this.rooms.save(left, room.version)

    if (stake !== null && stake.status === StakeStatus.Active) {
      this.releaser.releaseDeparted(saved.id, playerId, stake.holdOperationId, 'PARTICIPANT_LEFT')
    }

    return toBattleRoomDto(saved, playerId)
  }
}
