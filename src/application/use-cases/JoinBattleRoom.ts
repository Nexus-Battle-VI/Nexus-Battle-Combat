import {
  assessPrecombatEligibility,
  isIndividualFormat,
} from '../../domain/policies/PrecombatEligibilityPolicy'
import { RoomNotFoundError } from '../errors/ApplicationError'
import { PrecombatEligibilityBlockedError } from '../errors/PrecombatEligibilityError'
import { PlayerWithoutEquippedHeroError } from '../errors/UpstreamErrors'
import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import type { AccountBattleProfilePort } from '../ports/AccountBattleProfilePort'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { PlayerInventoryEquippedHeroPort } from '../ports/PlayerInventoryEquippedHeroPort'

/**
 * Une un jugador autenticado a una sala de batalla existente (HU-15.2, RF-15).
 *
 * ORDEN DE RESOLUCION AUTORITATIVA (fase de integracion cross-service, tras
 * confirmarse los contratos internos de Account y Player-Inventory):
 *
 *  1. `playerId` ya llega resuelto del controlador (`identity.subject` del
 *     JWT verificado, NUNCA del cuerpo).
 *  2. `AccountBattleProfilePort.getBattleProfile(playerId)` -> `displayName`
 *     (DP-2). Un `subject` verificado sin perfil en Account (HU-15.4) es
 *     informacion de negocio diagnosticable, no una caida de servicio: el
 *     puerto LANZA `AccountProfileMissingError` (422), nunca devuelve
 *     `null`. Un fallo de transporte real hacia Account (no alcanzable,
 *     timeout, 401, 5xx) lanza `UpstreamServiceError` (503) en su lugar.
 *  3. `PlayerInventoryEquippedHeroPort.getEquippedHero(playerId)` ->
 *     `heroId` (DP-4). `null` SI es un camino de negocio valido (el jugador
 *     no tiene heroe equipado todavia): se traduce a
 *     `PlayerWithoutEquippedHeroError` (422), no se deja pasar un
 *     `Participant` sin `heroId`.
 *  4. Carga de la sala (`RoomNotFoundError` si no existe).
 *  5. `PrecombatEligibilityPolicy.assessPrecombatEligibility()` (HU-16, RF-16,
 *     Management#25/#401/#402): con la sala YA cargada (para derivar el
 *     formato de sus equipos, DP-5) y el `EquippedHero` YA resuelto
 *     (`ready`, `blockers`, `subtype`), decide si ESTE heroe puede unirse a
 *     ESTA sala. No elegible -> `PrecombatEligibilityBlockedError` (422),
 *     CON los `blockers` completos (Player-Inventory reenviados tal cual,
 *     mas los propios de formato/clase). Esta politica NO evalua nivel de
 *     heroe, nivel minimo de sala ni mision activa: ninguno de los tres
 *     tiene hoy una fuente autoritativa real (auditoria HU-16.1, DP-2/DP-3/
 *     DP-4) y esta TASK no los inventa.
 *  6. `BattleRoom.join()` (dominio) valida, EN ORDEN: estado
 *     (`RoomNotJoinableError`), jugador duplicado
 *     (`PlayerAlreadyJoinedError`), nombre duplicado
 *     (`DuplicateDisplayNameError`, DP-2) y cupo del equipo
 *     (`RoomFullError`); agrega el participante -- capturando
 *     `EquippedHero.loadoutVersion` en `Participant.heroLoadoutVersion`
 *     (HU-16.2, DP-6: referencia verificable de la configuracion aprobada,
 *     sin revalidacion todavia porque no existe un punto futuro de
 *     "inicio de combate" en el dominio actual) -- y decide `PREPARING` si
 *     corresponde.
 *  7. `repository.save()` con el bloqueo optimista de la version leida.
 *
 * Si CUALQUIER paso 2-6 lanza, `repository.save()` NUNCA se invoca: no hay
 * persistencia parcial de un estado invalido, mismo criterio que la version
 * anterior de este caso de uso.
 *
 * La notificacion en tiempo real (`battle-room.updated`, ADR-020) la dispara
 * el adaptador de entrada tras un `execute()` exitoso, no este caso de uso:
 * mismo criterio de separacion que ya aplica el resto del servicio (HTTP no
 * conoce reglas de negocio, los casos de uso no conocen el transporte de
 * salida).
 */
export class JoinBattleRoom {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly clock: ClockPort,
    private readonly accountProfiles: AccountBattleProfilePort,
    private readonly equippedHeroes: PlayerInventoryEquippedHeroPort,
  ) {}

  async execute(roomId: string, playerId: string, team: string | null): Promise<BattleRoomDto> {
    const profile = await this.accountProfiles.getBattleProfile(playerId)
    const equippedHero = await this.equippedHeroes.getEquippedHero(playerId)

    if (equippedHero === null) {
      throw new PlayerWithoutEquippedHeroError(playerId)
    }

    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    const eligibility = assessPrecombatEligibility({
      heroSubtype: equippedHero.subtype,
      individualFormat: isIndividualFormat(room.teams),
      heroReady: equippedHero.ready,
      heroBlockers: equippedHero.blockers,
    })

    if (!eligibility.eligible) {
      throw new PrecombatEligibilityBlockedError(playerId, eligibility.blockers)
    }

    const joined = room.join(
      playerId,
      team,
      this.clock.now(),
      profile.displayName,
      equippedHero.heroId,
      equippedHero.loadoutVersion,
    )
    const saved = await this.rooms.save(joined, room.version)

    return toBattleRoomDto(saved)
  }
}
