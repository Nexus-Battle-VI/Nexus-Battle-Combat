import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'

/**
 * Lista las salas disponibles (HU-14, RF-14: "publicada en el listado de
 * salas activas"; "permanece disponible mientras tenga cupo").
 *
 * El repositorio filtra por `status == WAITING_FOR_PLAYERS` (lo que el motor
 * puede indexar); el caso de uso aplica `isAvailable()` para excluir tambien
 * las salas que ya completaron su cupo con `initialParticipants` declarados
 * al crear — la disponibilidad NO se persiste como booleano (HU-14.1,
 * `HU-14.1-Contrato-Creacion-Sala.md`, seccion 2).
 */
export class ListAvailableBattleRooms {
  constructor(private readonly rooms: BattleRoomRepositoryPort) {}

  async execute(viewerId: string | null = null): Promise<readonly BattleRoomDto[]> {
    const candidates = await this.rooms.findWaitingForPlayers()

    return candidates
      .filter((room) => room.isAvailable())
      .map((room) => toBattleRoomDto(room, viewerId))
  }
}
