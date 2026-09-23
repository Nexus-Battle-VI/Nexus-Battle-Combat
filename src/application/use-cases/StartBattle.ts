import type { BattleRoom } from '../../domain/entities/BattleRoom'
import { Combatant } from '../../domain/entities/Combatant'
import { createCombatProfile } from '../../domain/entities/CombatProfile'
import { ParticipantKind } from '../../domain/entities/Participant'
import type { RosterMember, TeamRoster } from '../../domain/entities/TurnOrder'
import { InvalidCombatProfileError, RoomNotStartableError } from '../../domain/errors/BattleErrors'
import {
  assessPrecombatEligibility,
  isIndividualFormat,
  type PrecombatEligibilityBlocker,
} from '../../domain/policies/PrecombatEligibilityPolicy'
import {
  assertBalancedTeams,
  generateTurnOrder,
  type BoundedRandom,
} from '../../domain/policies/TurnOrderPolicy'
import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../errors/ApplicationError'
import { PrecombatEligibilityBlockedError } from '../errors/PrecombatEligibilityError'
import { PlayerWithoutEquippedHeroError, UpstreamServiceError } from '../errors/UpstreamErrors'
import type { BattleEventPublisherPort } from '../ports/BattleEventPublisherPort'
import type { BattleConnectionsPort } from '../ports/BattleConnectionsPort'
import type { BattleDeadlineBookPort } from '../ports/BattleDeadlineBookPort'
import type { BattlePresencePort } from '../ports/BattlePresencePort'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type {
  EquippedHero,
  PlayerInventoryEquippedHeroPort,
} from '../ports/PlayerInventoryEquippedHeroPort'
import { combatProfileFrom } from '../services/CombatProfileFactory'

/** El heroe equipado ya no es el que se aprobo al unirse (HU-16, TOCTOU). */
export const HERO_CHANGED_SINCE_JOIN = 'HERO_CHANGED_SINCE_JOIN'
/** La configuracion de equipamiento cambio desde que se aprobo al unirse (HU-16.2, DP-6). */
export const HERO_LOADOUT_CHANGED = 'HERO_LOADOUT_CHANGED'

/**
 * Inicia la batalla de una sala preparada (HU-17, RF-17).
 *
 * Orden (ADR-020: persistir antes de difundir):
 *
 *  1. Cargar la sala; solo un participante puede consultarla (403 si no lo
 *     es). La identidad es SIEMPRE `identity.subject`; el comando no tiene
 *     cuerpo, asi que ningun cliente elige quien inicia ni quien participa.
 *  2. IDEMPOTENTE: si la sala ya esta `IN_BATTLE` devuelve el estado vigente
 *     a CUALQUIER participante, sin generar otra cola ni otro `battleStarted`
 *     — necesario porque tras el evento realtime todos los clientes pueden
 *     seguir consultando el estado.
 *  3. Solo `requesterId === room.createdBy` puede iniciar (403
 *     `RoomAccessForbiddenError` en otro caso, mismo patron que `cancel()` en
 *     `BattleRoom.ts`). Antes del 2026-09-22 cualquier participante HUMAN
 *     podia iniciarla; el lobby de Web ahora solo expone el boton al
 *     propietario, pero el backend es quien lo hace cumplir.
 *  5. Solo desde `PREPARING` (409 en otro caso) y con equipos del MISMO tamano
 *     (422 `UNSUPPORTED_TEAM_COMPOSITION`: RF-17 no define el orden cuando un
 *     equipo se agota antes y no se inventa esa regla).
 *  6. REVALIDACION PRECOMBATE (HU-16) de cada participante HUMAN con los mismos
 *     puertos y la misma politica que `JoinBattleRoom`: el heroe equipado debe
 *     existir, ser el mismo que se aprobo, seguir siendo elegible y conservar
 *     la version de equipamiento capturada al unirse. Si CUALQUIERA falla, no
 *     hay cola, no hay `battleStarted` y la sala sigue `PREPARING`. Los `AI` no
 *     tienen heroe equipado que validar. NO se reimplementa equipamiento.
 *  7. Generar la cola con la fuente centralizada de HU-24 (`BoundedRandom`).
 *     Las estadisticas no entran en el orden; solo se copia el subtipo del
 *     heroe para PRESENTACION.
 *  8. `BattleRoom.startBattle()` + `save` con bloqueo optimista.
 *  9. SOLO despues de persistir, publicar `battleStarted`.
 *
 * Una carrera entre dos participantes que inician a la vez resuelve por el
 * bloqueo optimista: el perdedor relee la sala y, si ya esta `IN_BATTLE`,
 * devuelve ese estado (mismo resultado idempotente), sin segundo evento.
 */
export class StartBattle {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly clock: ClockPort,
    private readonly equippedHeroes: PlayerInventoryEquippedHeroPort,
    private readonly random: BoundedRandom,
    private readonly publisher: BattleEventPublisherPort,
    /**
     * HU-21: presencia y libro de vencimientos. Opcionales para no romper las
     * construcciones que no necesitan sembrar la gracia; en produccion se
     * inyectan los tres juntos.
     */
    private readonly presence: BattlePresencePort | null = null,
    private readonly book: BattleDeadlineBookPort | null = null,
    private readonly connections: BattleConnectionsPort | null = null,
  ) {}

  async execute(roomId: string, requesterId: string): Promise<BattleRoomDto> {
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    if (!room.isParticipant(requesterId)) {
      throw new RoomAccessForbiddenError(roomId)
    }

    if (room.status === BattleRoomStatus.InBattle) {
      return toBattleRoomDto(room, requesterId)
    }

    if (requesterId !== room.createdBy) {
      throw new RoomAccessForbiddenError(roomId)
    }

    if (room.status !== BattleRoomStatus.Preparing) {
      throw new RoomNotStartableError(room.id, room.status)
    }

    // Antes de revalidar a nadie (llamadas a Player-Inventory) y antes de sortear:
    // una composicion que HU-17 no sabe ordenar no puede iniciar batalla.
    assertBalancedTeams(room.roster())

    const { rosters, combatants } = await this.revalidate(room)
    const order = generateTurnOrder(rosters, this.random)
    const started = room.startBattle(order, this.clock.now(), combatants)

    let saved
    try {
      saved = await this.rooms.save(started, room.version)
    } catch (error: unknown) {
      if (error instanceof RoomConflictError) {
        const current = await this.rooms.findById(roomId)

        if (current?.status === BattleRoomStatus.InBattle) {
          return toBattleRoomDto(current, requesterId)
        }
      }

      throw error
    }

    this.publish(saved.id, saved.events)
    this.seedPresence(saved)

    return toBattleRoomDto(saved, requesterId)
  }

  /**
   * HU-21 (contrato §4.2, "semilla de presencia"): quien no tiene una conexion
   * de batalla EN ESTE INSTANTE empieza su gracia de 30 s en `startedAt`. El
   * puerto de presencia no conoce conexiones; quien las conoce es el gateway
   * (`BattleConnectionsPort`, solo lectura), y el gateway no depende de este
   * caso de uso, asi que no hay ciclo.
   *
   * Despues de sembrar, la sala queda registrada en el libro de vencimientos con
   * el mas inminente (incluidas las gracias recien abiertas).
   */
  private seedPresence(saved: BattleRoom): void {
    const presence = this.presence
    const battle = saved.battle

    if (presence === null || battle === null) {
      return
    }

    for (const entry of battle.turnOrder) {
      if (entry.kind !== ParticipantKind.Human || entry.playerId === null) {
        continue
      }

      if (!(this.connections?.isConnected(saved.id, entry.playerId) ?? false)) {
        presence.markAbsent(saved.id, entry.playerId, battle.startedAt)
      }
    }

    const due = saved.nextDueAt(presence.absences(saved.id))

    if (due !== null) {
      this.book?.ensureDueBy(saved.id, due)
    }
  }

  /**
   * Revalida a cada HUMAN y devuelve la lista definitiva con el subtipo de
   * presentacion y el SNAPSHOT DE COMBATE congelado (HU-18): con la misma respuesta de
   * Player-Inventory que ya se pidio para revalidar HU-16, sin una segunda llamada.
   * Los `AI` no tienen perfil (no hay fuente autoritativa de sus estadisticas).
   */
  private async revalidate(room: BattleRoom): Promise<{
    readonly rosters: readonly [TeamRoster, TeamRoster]
    readonly combatants: readonly Combatant[]
  }> {
    const individualFormat = isIndividualFormat(room.teams)
    const rosters = room.roster()
    const humans = rosters.flatMap((roster) =>
      roster.members.flatMap((member) =>
        member.kind === ParticipantKind.Human && member.playerId !== null
          ? [{ member, playerId: member.playerId }]
          : [],
      ),
    )
    const heroes = new Map<string, EquippedHero | null>()

    await Promise.all(
      humans.map(async ({ playerId }) => {
        heroes.set(playerId, await this.equippedHeroes.getEquippedHero(playerId))
      }),
    )

    const enriched = new Map<string, RosterMember>()
    const profiles = new Map<string, Combatant>()

    for (const { member, playerId } of humans) {
      const hero = heroes.get(playerId) ?? null

      if (hero === null) {
        throw new PlayerWithoutEquippedHeroError(playerId)
      }

      const participant = room.teams
        .flatMap((team) => team.participants)
        .find((candidate) => candidate.playerId === playerId)
      const blockers: PrecombatEligibilityBlocker[] = []

      if (participant?.heroId != null && participant.heroId !== hero.heroId) {
        blockers.push(
          changed(
            HERO_CHANGED_SINCE_JOIN,
            hero.reference,
            'El heroe equipado cambio despues de unirse a la sala.',
          ),
        )
      }

      if (
        participant?.heroLoadoutVersion != null &&
        participant.heroLoadoutVersion !== hero.loadoutVersion
      ) {
        blockers.push(
          changed(
            HERO_LOADOUT_CHANGED,
            hero.reference,
            'El equipamiento del heroe cambio despues de aprobarse al unirse a la sala.',
          ),
        )
      }

      const eligibility = assessPrecombatEligibility({
        heroSubtype: hero.subtype,
        individualFormat,
        heroReady: hero.ready,
        heroBlockers: hero.blockers,
      })

      blockers.push(...eligibility.blockers)

      if (blockers.length > 0) {
        throw new PrecombatEligibilityBlockedError(playerId, blockers)
      }

      enriched.set(playerId, {
        ...member,
        heroId: member.heroId ?? hero.heroId,
        heroSubtype: hero.subtype,
      })
      profiles.set(playerId, this.freeze(member, hero))
    }

    const withSubtype = (roster: TeamRoster): TeamRoster => ({
      label: roster.label,
      members: roster.members.map((member) =>
        member.playerId === null ? member : (enriched.get(member.playerId) ?? member),
      ),
    })

    const finalRosters: readonly [TeamRoster, TeamRoster] = [
      withSubtype(rosters[0]),
      withSubtype(rosters[1]),
    ]
    const combatants = finalRosters
      .flatMap((roster) => roster.members)
      .map((member) =>
        member.playerId === null
          ? Combatant.start(member, null)
          : (profiles.get(member.playerId) ?? Combatant.start(member, null)),
      )

    return { rosters: finalRosters, combatants }
  }

  /** Congela el perfil de un HUMAN; un dato upstream mal formado es un fallo del servicio, no del jugador. */
  private freeze(member: RosterMember, hero: EquippedHero): Combatant {
    try {
      return Combatant.start(member, createCombatProfile(combatProfileFrom(hero)))
    } catch (error: unknown) {
      if (error instanceof InvalidCombatProfileError) {
        throw new UpstreamServiceError('player-inventory', 'respuesta_invalida')
      }

      throw error
    }
  }

  /** La difusion nunca revienta la operacion: el estado ya esta persistido (`resume` lo recupera). */
  private publish(
    roomId: string,
    events: Parameters<BattleEventPublisherPort['publish']>[1],
  ): void {
    try {
      this.publisher.publish(roomId, events)
    } catch {
      // Deliberadamente silencioso: ver el comentario del metodo.
    }
  }
}

const changed = (code: string, reference: string, detail: string): PrecombatEligibilityBlocker => ({
  code,
  slot: null,
  reference,
  detail,
})
