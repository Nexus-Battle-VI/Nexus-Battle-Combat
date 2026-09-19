import { RoomNotFoundError } from '../errors/ApplicationError'
import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'

/**
 * Une un jugador autenticado a una sala de batalla existente (HU-15.2, RF-15
 * — subconjunto implementable segun `HU-15.2-Plan-Implementacion.md`).
 *
 * Mismo patron que `CancelBattleRoom`: la precondicion de negocio
 * ("solo WAITING_FOR_PLAYERS admite ingreso", cupo, unicidad de jugador,
 * transicion a PREPARING) la aplica `BattleRoom.join()` (dominio); este caso
 * de uso solo resuelve la busqueda, obtiene `joinedAt` de `ClockPort` (NUNCA
 * del cliente), delega la mutacion y persiste con el bloqueo optimista de la
 * version leida. Si `room.join()` lanza (sala no unible, sin cupo, jugador
 * duplicado), `repository.save()` NUNCA se invoca: no hay persistencia
 * parcial de un estado invalido.
 *
 * `playerId` y `team` llegan YA resueltos por el controlador: `playerId` es
 * siempre `identity.subject` del testimonio verificado, `team` es el valor
 * opcional del cuerpo de la peticion (o `null` para asignacion automatica).
 * Este caso de uso nunca lee `playerId`/`subject` de la peticion.
 */
export class JoinBattleRoom {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(roomId: string, playerId: string, team: string | null): Promise<BattleRoomDto> {
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    const joined = room.join(playerId, team, this.clock.now())
    const saved = await this.rooms.save(joined, room.version)

    return toBattleRoomDto(saved)
  }
}
