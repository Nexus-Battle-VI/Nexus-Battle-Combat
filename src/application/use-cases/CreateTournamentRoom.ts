import {
  BattleRoom,
  type CreateTournamentRoomInput,
  type TournamentRosterMemberInput,
  type TournamentTeamInput,
} from '../../domain/entities/BattleRoom'
import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import { RoomConflictError } from '../errors/ApplicationError'
import { TournamentRoomOperationReusedError } from '../errors/TournamentRoomErrors'
import { PlayerWithoutEquippedHeroError } from '../errors/UpstreamErrors'
import type { AccountBattleProfilePort } from '../ports/AccountBattleProfilePort'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import type { PlayerInventoryEquippedHeroPort } from '../ports/PlayerInventoryEquippedHeroPort'

export interface TournamentRoomTeamRequest {
  readonly teamId: string
  readonly memberIds: readonly string[]
}

export interface CreateTournamentRoomRequest {
  readonly operationId: string
  readonly tournamentId: string
  readonly encounterId: string
  readonly teams: readonly [TournamentRoomTeamRequest, TournamentRoomTeamRequest]
}

/**
 * Crea la sala de combate de una justa de torneo (Management#517, EN de
 * `tournament-rooms`; HU-83/HU-85 del lado Tournament, Management#465/#470).
 * Ruta interna HMAC, consumida unicamente por el servicio Tournament -- NUNCA
 * por un cliente con testimonio de jugador.
 *
 * IDEMPOTENTE POR `operationId` (mismo mecanismo que
 * `AcceptMissionSimulationRequest`/HU-72, pero resuelto contra el propio
 * documento de la sala en vez de una coleccion aparte -- ver el comentario de
 * `TournamentRoomMetadata` en `BattleRoom.ts`):
 *
 *  1. Si YA existe una sala con este `operationId`: mismo `requestHash` ->
 *     se devuelve ESA MISMA sala (mismo `roomId`), sin crear una segunda.
 *     `requestHash` distinto -> `TournamentRoomOperationReusedError` (409).
 *  2. Si no existe: resuelve identidad (`AccountBattleProfilePort`) y heroe
 *     equipado (`PlayerInventoryEquippedHeroPort`) de CADA uno de los 4
 *     jugadores humanos -- LOS MISMOS PUERTOS que `JoinBattleRoom` usa en el
 *     flujo normal, nunca reinventados aqui. Sin heroe equipado ->
 *     `PlayerWithoutEquippedHeroError` (422), igual que al unirse por el
 *     lobby publico. La elegibilidad precombate (readiness, formato) NO se
 *     revalida aqui a proposito: `StartTournamentRoom` ya la revalida
 *     completa al iniciar (via `StartBattle`), y duplicarla aqui solo
 *     adelantaria el mismo 422 sin aportar una garantia nueva.
 *  3. `BattleRoom.createTournamentRoom()` construye el agregado YA en
 *     `PREPARING`, aislado del lobby publico (ver su comentario).
 *  4. `repository.save(room, 0)` con el indice unico de Mongo sobre
 *     `tournament.operationId` (migracion 018) como EXCLUSION MUTUA real: si
 *     dos peticiones concurrentes con el MISMO `operationId` llegan aqui a la
 *     vez, solo una inserta; la otra recibe `RoomConflictError` y relee por
 *     `findByTournamentOperationId` para devolver (o rechazar) igual que en
 *     el paso 1 -- nunca una segunda sala.
 *
 * La identidad de un jugador participante NUNCA suplanta al creador: `createdBy`
 * es un identificador SINTETICO del servicio Tournament (`tournament:<tournamentId>`),
 * nunca uno de los 4 `playerId` del roster.
 */
export class CreateTournamentRoom {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly accountProfiles: AccountBattleProfilePort,
    private readonly equippedHeroes: PlayerInventoryEquippedHeroPort,
  ) {}

  async execute(request: CreateTournamentRoomRequest, requestHash: string): Promise<BattleRoomDto> {
    const existing = await this.rooms.findByTournamentOperationId(request.operationId)

    if (existing !== null) {
      return CreateTournamentRoom.replayOf(existing, request.operationId, requestHash)
    }

    const [teamA, teamB] = await Promise.all([
      this.resolveTeam(request.teams[0]),
      this.resolveTeam(request.teams[1]),
    ])

    const input: CreateTournamentRoomInput = {
      operationId: request.operationId,
      tournamentId: request.tournamentId,
      encounterId: request.encounterId,
      requestHash,
      teams: [teamA, teamB],
    }

    const roomId = this.ids.generate()
    // Sintetico, nunca un playerId: ver el comentario de la clase.
    const createdBy = `tournament:${request.tournamentId}`
    const room = BattleRoom.createTournamentRoom(roomId, createdBy, input, this.clock.now())

    try {
      const saved = await this.rooms.save(room, 0)

      return toBattleRoomDto(saved, null)
    } catch (error: unknown) {
      if (error instanceof RoomConflictError) {
        // Otra peticion con el MISMO operationId gano la carrera de insercion
        // (indice unico de la migracion 018): releer y resolver igual que un
        // reintento secuencial, nunca una segunda sala.
        const winner = await this.rooms.findByTournamentOperationId(request.operationId)

        if (winner !== null) {
          return CreateTournamentRoom.replayOf(winner, request.operationId, requestHash)
        }
      }

      throw error
    }
  }

  private async resolveTeam(team: TournamentRoomTeamRequest): Promise<TournamentTeamInput> {
    const members = await Promise.all(
      team.memberIds.map((playerId) => this.resolveMember(playerId)),
    )

    return { teamId: team.teamId, members }
  }

  private async resolveMember(playerId: string): Promise<TournamentRosterMemberInput> {
    const [profile, hero] = await Promise.all([
      this.accountProfiles.getBattleProfile(playerId),
      this.equippedHeroes.getEquippedHero(playerId),
    ])

    if (hero === null) {
      throw new PlayerWithoutEquippedHeroError(playerId)
    }

    return {
      playerId,
      heroId: hero.heroId,
      heroLoadoutVersion: hero.loadoutVersion,
      displayName: profile.displayName,
    }
  }

  private static replayOf(
    room: BattleRoom,
    operationId: string,
    requestHash: string,
  ): BattleRoomDto {
    if (room.tournament?.requestHash !== requestHash) {
      throw new TournamentRoomOperationReusedError(operationId)
    }

    return toBattleRoomDto(room, null)
  }
}
