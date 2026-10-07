import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import { RoomNotFoundError } from '../errors/ApplicationError'
import {
  NotATournamentRoomError,
  TournamentRoomMismatchError,
} from '../errors/TournamentRoomErrors'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { StartBattle } from './StartBattle'

export interface StartTournamentRoomRequest {
  readonly operationId: string
  readonly tournamentId: string
  readonly encounterId: string
}

/**
 * Inicia la batalla de una sala de torneo YA CREADA (Management#517).
 *
 * NO REIMPLEMENTA NADA DEL MOTOR: delega en `StartBattle`, EL MISMO caso de
 * uso que el lobby publico usa en `POST /rooms/:id/start` -- revalidacion
 * precombate, compromiso de heroes (HU-29), aleatoriedad centralizada
 * (HU-24), generacion de la cola de turnos y difusion de `battleStarted`
 * quedan IDENTICOS. Esta clase solo decide QUE sala arrancar y, para la
 * tournament specific idempotencia que `StartBattle` no cubre, CUANDO no
 * hace falta llamarlo en absoluto.
 *
 * `StartBattle.execute()` solo trata `IN_BATTLE` como idempotente (devuelve
 * el estado vigente); desde cualquier otro estado distinto de `PREPARING`
 * lanza `RoomNotStartableError` (409) -- lo que ROMPERIA la idempotencia que
 * esta ruta promete tras `FINISHED` (reenviar `/start` sobre una sala ya
 * terminada debe devolver esa misma sala, no un 409). Por eso esta clase
 * decide la idempotencia ANTES de delegar, sin tocar `StartBattle`.
 *
 * Llama a `StartBattle.startRoom()`, NO a `.execute()`: esta ultima exige
 * `requesterId` como JWT de un participante Y el creador a la vez, dos
 * condiciones pensadas para la ruta publica que `room.createdBy` -- el
 * identificador SINTETICO que `CreateTournamentRoom` le dio a la sala
 * (`tournament:<tournamentId>`, nunca un `playerId`) -- jamas podria
 * satisfacer por diseño (no es participante). La autorizacion de ESTA
 * llamada ya ocurrio en el guard HMAC de la ruta interna; ver el comentario
 * de `StartBattle.startRoom()`.
 */
export class StartTournamentRoom {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly startBattle: StartBattle,
  ) {}

  async execute(roomId: string, request: StartTournamentRoomRequest): Promise<BattleRoomDto> {
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    if (room.tournament === null) {
      throw new NotATournamentRoomError(roomId)
    }

    if (
      room.tournament.tournamentId !== request.tournamentId ||
      room.tournament.encounterId !== request.encounterId
    ) {
      throw new TournamentRoomMismatchError(roomId)
    }

    if (room.status === BattleRoomStatus.InBattle || room.status === BattleRoomStatus.Finished) {
      return toBattleRoomDto(room, null)
    }

    // `StartBattle.startRoom()`, NO `.execute()`: esta ya es una llamada
    // interna autorizada (HMAC), y `room.createdBy` -- sintetico, nunca un
    // playerId -- jamas pasaria las comprobaciones de identidad de
    // `execute()` (pensadas para un testimonio JWT de jugador). Ver el
    // comentario de `StartBattle.startRoom()`.
    return this.startBattle.startRoom(roomId)
  }
}
