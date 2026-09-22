import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import { RoomAccessForbiddenError, RoomNotFoundError } from '../errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'

/**
 * Lee una sala y, si esta en curso, su batalla (HU-17). SOLO para sus
 * participantes: existe porque `GET /rooms` solo lista salas en
 * `WAITING_FOR_PLAYERS`, de modo que al pasar a `PREPARING` o `IN_BATTLE` un
 * cliente perdia toda forma HTTP de leerla. La identidad es `identity.subject`.
 */
export class GetBattleRoom {
  constructor(private readonly rooms: BattleRoomRepositoryPort) {}

  async execute(roomId: string, requesterId: string): Promise<BattleRoomDto> {
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    if (!room.isParticipant(requesterId)) {
      throw new RoomAccessForbiddenError(roomId)
    }

    return toBattleRoomDto(room, requesterId)
  }
}
