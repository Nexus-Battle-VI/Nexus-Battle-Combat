import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'

/**
 * Salas no terminales en las que participa quien pregunta (y las que creo y
 * siguen esperando jugadores): "volver a mi sala" / "continuar batalla" en
 * Jugar Online.
 *
 * El listado publico (`ListAvailableBattleRooms`) solo devuelve salas
 * `WAITING_FOR_PLAYERS` con cupo, asi que una sala propia llena, en
 * `PREPARING` o en `IN_BATTLE` desaparecia de la vista y solo se recuperaba
 * conociendo su id. El servidor es la autoridad: la Web no guarda el id en
 * almacenamiento local.
 *
 * `playerId` es SIEMPRE el sujeto verificado del testimonio. La respuesta
 * reutiliza `toBattleRoomDto` con ese mismo sujeto como observador, de modo
 * que la privacidad de las apuestas ajenas es la misma que en `GET /rooms/:id`.
 */
export class ListMyActiveBattleRooms {
  constructor(private readonly rooms: BattleRoomRepositoryPort) {}

  async execute(playerId: string): Promise<readonly BattleRoomDto[]> {
    const rooms = await this.rooms.findActiveByParticipant(playerId)

    return rooms.map((room) => toBattleRoomDto(room, playerId))
  }
}
