import { RoomNotFoundError } from '../errors/ApplicationError'
import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'

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
 */
export class LeaveBattleRoom {
  constructor(private readonly rooms: BattleRoomRepositoryPort) {}

  async execute(roomId: string, playerId: string): Promise<BattleRoomDto> {
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    const left = room.leave(playerId)
    const saved = await this.rooms.save(left, room.version)

    return toBattleRoomDto(saved)
  }
}
