import { RoomNotFoundError } from '../errors/ApplicationError'
import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { StakeReleaser } from '../services/StakeReleaser'

/**
 * Cancela una sala de batalla (RF-14: "hasta que ... el creador la
 * cancele").
 *
 * La precondicion "solo el creador, solo en WAITING_FOR_PLAYERS" la aplica
 * `BattleRoom.cancel()` (dominio); este caso de uso solo resuelve la
 * busqueda, delega la transicion y persiste con el bloqueo optimista de la
 * version leida.
 *
 * HU-23 (§7, D6): tras persistir la cancelacion se liberan TODAS las
 * apuestas `ACTIVE` de la sala, fire-and-forget: cancelar NUNCA falla porque
 * Wallet este caido. Lo que no confirme queda `ACTIVE` en una sala
 * `CANCELLED` y lo retoma `ReconcileStakes`.
 */
export class CancelBattleRoom {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly releaser: StakeReleaser,
  ) {}

  async execute(roomId: string, requestedBy: string): Promise<BattleRoomDto> {
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    const cancelled = room.cancel(requestedBy)
    const saved = await this.rooms.save(cancelled, room.version)

    this.releaser.releaseAll(saved, 'ROOM_CANCELLED')

    return toBattleRoomDto(saved, requestedBy)
  }
}
