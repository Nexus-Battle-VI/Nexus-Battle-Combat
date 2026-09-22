import { DomainError } from '../errors/DomainError'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  InvalidBattleRosterError,
  InvalidCommandIdError,
  InvalidTargetError,
  NotYourTurnError,
  RoomNotStartableError,
  SameTeamTargetError,
  SkillOnCooldownError,
  SkillsNotAvailableError,
  TargetUnavailableError,
  UnknownSkillError,
  UnsupportedCombatProfileError,
  UnsupportedSkillEffectError,
} from '../errors/BattleErrors'
import {
  applyDamage,
  assertSupportedDamage,
  calculateDamage,
  type SupportedDamage,
} from '../policies/BasicAttackDamagePolicy'
import { spendPower } from '../policies/HeroPowerPolicy'
import { evaluateSkill, type SkillBonus } from '../policies/SkillEffectPolicy'
import {
  DuplicateDisplayNameError,
  InvalidModeCompositionError,
  InvalidRoomCapacityError,
  InvalidTeamCapacityError,
  PlayerAlreadyJoinedError,
  PlayerNotInRoomError,
  RoomCancellationForbiddenError,
  RoomFullError,
  RoomNotCancellableError,
  RoomNotJoinableError,
  RoomNotLeavableError,
} from '../errors/BattleRoomErrors'
import { BattleRoomId } from '../value-objects/BattleRoomId'
import { BattleMode, parseBattleMode } from '../value-objects/BattleMode'
import { BattleRoomStatus, parseBattleRoomStatus } from '../value-objects/BattleRoomStatus'
import { RewardConfig, type RewardConfigSnapshot } from '../value-objects/RewardConfig'
import {
  findEliminatedTeam,
  lifePercentForDisplay,
  resolveTimeLimit,
  teamLives,
  type TeamLife,
} from '../policies/BattleOutcomePolicy'
import {
  battleDeadline,
  graceDeadline,
  hasReached,
  turnDeadline,
} from '../policies/BattleTimingPolicy'
import {
  ParticipantResultKind as ParticipantResults,
  type BattleOutcome,
  type BattleResult,
  type ParticipantOutcome,
  type TeamStanding,
  type TiebreakRule,
} from './BattleResult'
import {
  createParticipant,
  ParticipantKind,
  type Participant,
  type ParticipantInput,
} from './Participant'
import { Team, type TeamSnapshot } from './Team'
import {
  BattleEventType,
  type BattleEvent,
  type DegradedFrom,
  type HandledCommand,
} from './BattleEvent'
import { BattleState, type BattleStateSnapshot, type BattleView } from './BattleState'
import type { Combatant, CombatantKey } from './Combatant'
import type { CombatAbility, CombatProfile } from './CombatProfile'
import { memberKey, type TeamRoster, type TurnOrderEntry } from './TurnOrder'

/**
 * Ataque basico ya VALIDADO (HU-18), listo para resolverse: todas las
 * comprobaciones que no necesitan aleatoriedad ocurren antes, asi que una
 * peticion invalida consume 0 sorteos.
 */
export interface BasicAttackReadyPlan {
  readonly kind: 'ready'
  readonly attackerEntry: TurnOrderEntry
  readonly targetEntry: TurnOrderEntry
  readonly attacker: Combatant
  readonly target: Combatant
  readonly attackerProfile: CombatProfile
  readonly targetProfile: CombatProfile
  /** Vida actual del objetivo, leida del estado persistido (nunca del cliente). */
  readonly targetHealth: number
  /** Dano del atacante ya comprobado como soportado (`DICE` o `FIXED`). */
  readonly damage: SupportedDamage
}

/** El `commandId` ya se proceso: se devuelve el evento persistido, sin volver a sortear ni mutar. */
export interface BasicAttackReplay {
  readonly kind: 'replay'
  readonly event: BattleEvent
}

export type BasicAttackPlan = BasicAttackReadyPlan | BasicAttackReplay

/** Lo que HU-20 y el sorteo de dano produjeron para este golpe. */
export interface BasicAttackOutcome {
  readonly attackValue: number
  readonly defenseValue: number
  readonly effective: boolean
  readonly effect: string | null
  readonly percent: number | null
  /** `null` si el golpe no fue efectivo o si el efecto (0 %) no requirio tirar el dano. */
  readonly baseDamage: number | null
}

/** Una habilidad ya VALIDADA (HU-19), lista para resolverse: 0 sorteos hasta aqui. */
export interface SkillReadyPlan {
  readonly kind: 'skill'
  readonly attackerEntry: TurnOrderEntry
  readonly targetEntry: TurnOrderEntry
  readonly attacker: Combatant
  readonly target: Combatant
  readonly attackerProfile: CombatProfile
  readonly targetProfile: CombatProfile
  readonly targetHealth: number
  readonly damage: SupportedDamage
  readonly ability: CombatAbility
  /** Bonos de la habilidad al Ataque y al Dano, ya agregados por `evaluateSkill`. */
  readonly attackBonus: SkillBonus
  readonly damageBonus: SkillBonus
  /** Poder del actor antes de pagar y el que le queda despues (`spendPower`). */
  readonly powerBefore: number
  readonly powerAfter: number
}

/** El Poder no alcanza: la accion se degrada a un ataque basico contra el mismo objetivo (HU-11). */
export interface SkillDegradedPlan {
  readonly kind: 'degraded'
  readonly abilityId: string
}

export type SkillPlan = SkillReadyPlan | SkillDegradedPlan | BasicAttackReplay

/** Lo que HU-20, HU-25 y el sorteo de dano produjeron para una habilidad. */
export interface SkillOutcome extends BasicAttackOutcome {
  /** Bono de Ataque de la habilidad (fijo + dados), ya incluido en `attackValue`. */
  readonly attackBonus: number
  /** Bono de Dano (fijo + dados), ya incluido en `baseDamage`; `null` si no se tiro. */
  readonly damageBonus: number | null
}

export interface TeamConfigInput {
  readonly capacity: number
  readonly initialParticipants?: readonly ParticipantInput[]
}

export interface CreateBattleRoomInput {
  readonly mode: string
  /**
   * Longitud fija 2 por contrato (HU-14.1), pero se recibe como arreglo
   * (no tupla) porque procede de una peticion HTTP externa: la longitud se
   * valida en tiempo de ejecucion, no se asume del tipo.
   */
  readonly teamConfigs: readonly TeamConfigInput[]
  readonly reward: { readonly amount: number }
}

export interface BattleRoomSnapshot {
  readonly id: string
  readonly mode: BattleMode
  readonly status: BattleRoomStatus
  readonly teams: readonly [TeamSnapshot, TeamSnapshot]
  readonly reward: RewardConfigSnapshot
  readonly createdBy: string
  readonly createdAt: Date
  readonly version: number
  /** HU-17: batalla en curso (`null` hasta `startBattle()`). */
  readonly battle: BattleStateSnapshot | null
  /** HU-17: bitacora de eventos de batalla con `seq` (ADR-020). */
  readonly events: readonly BattleEvent[]
  /** HU-17: comandos ya procesados, para deduplicar por `commandId`. */
  readonly handledCommands: readonly HandledCommand[]
  /**
   * HU-21: resultado unico de la batalla. `null` mientras esta en curso; no nulo
   * si y solo si la sala esta `FINISHED` (invariante de la migracion `009`).
   */
  readonly result: BattleResult | null
}

/**
 * Lo que `restore()` acepta: los campos de HU-17 son opcionales para que los
 * documentos y las instantaneas anteriores a la batalla sigan restaurandose
 * sin migracion de datos (ausente = sin batalla, sin eventos, sin comandos).
 * `result` es opcional por el mismo motivo: un documento anterior a HU-21 no lo
 * tiene y se restaura como `null`.
 */
export type RestorableBattleRoomSnapshot = Omit<
  BattleRoomSnapshot,
  'battle' | 'events' | 'handledCommands' | 'result'
> &
  Partial<Pick<BattleRoomSnapshot, 'battle' | 'events' | 'handledCommands' | 'result'>>

/** Estado de batalla que acompana a la sala; vacio hasta HU-17 `startBattle()`. */
interface BattleExtras {
  readonly battle: BattleState | null
  readonly events: readonly BattleEvent[]
  readonly handledCommands: readonly HandledCommand[]
  /** HU-21: opcional en los constructores internos; ausente equivale a `null`. */
  readonly result?: BattleResult | null
}

const NO_BATTLE: BattleExtras = { battle: null, events: [], handledCommands: [], result: null }

/**
 * Causa con la que se finaliza una sala (HU-21, contrato §4). No es un estado:
 * se traduce al campo `reason` del resultado.
 */
export type FinishCause =
  | { readonly reason: 'ELIMINATION'; readonly winnerTeamLabel: string }
  | { readonly reason: 'DISCONNECTION'; readonly disconnected: CombatantKey }
  | { readonly reason: 'TIME_LIMIT' }

/** Longitud maxima de un `commandId` (ADR-020). */
const MAX_COMMAND_ID_LENGTH = 100

/**
 * Sala de batalla (HU-14, RF-14). Aggregate root: cupo, equipos, modalidad,
 * recompensa y estado cambian juntos en una sola escritura (HU-14.1,
 * `HU-14.1-Decisiones-Tecnicas.md`, punto 1). HU-17 extiende ESTE agregado con
 * la batalla (cola de turnos inmutable, contador de progreso y bitacora de
 * eventos con `seq`) en lugar de crear otra entidad: ADR-019 declara que la
 * batalla es un unico agregado y una sola escritura atomica es lo que permite
 * "persistir antes de difundir" (ADR-020).
 */
export class BattleRoom {
  readonly id: string
  readonly mode: BattleMode
  readonly status: BattleRoomStatus
  readonly teams: readonly [Team, Team]
  readonly reward: RewardConfig
  readonly createdBy: string
  readonly createdAt: Date
  readonly battle: BattleState | null
  readonly events: readonly BattleEvent[]
  readonly handledCommands: readonly HandledCommand[]
  /** HU-21: resultado unico; `null` mientras la batalla no haya terminado. */
  readonly result: BattleResult | null
  private readonly _version: number

  private constructor(
    id: string,
    mode: BattleMode,
    status: BattleRoomStatus,
    teams: readonly [Team, Team],
    reward: RewardConfig,
    createdBy: string,
    createdAt: Date,
    version: number,
    extras: BattleExtras = NO_BATTLE,
  ) {
    this.id = id
    this.mode = mode
    this.status = status
    this.teams = teams
    this.reward = reward
    this.createdBy = createdBy
    this.createdAt = createdAt
    this._version = version
    this.battle = extras.battle
    this.events = extras.events
    this.handledCommands = extras.handledCommands
    this.result = extras.result ?? null
  }

  /**
   * Crea una sala nueva en `WAITING_FOR_PLAYERS` (RF-14/CA-01: "Sala creada
   * con estado Esperando jugadores"). Orden de validacion, igual que
   * `HU-14.1-Contrato-Creacion-Sala.md`, seccion "Validaciones": 1) sintaxis
   * y tipos (`DomainError`, 400); 2) reglas de negocio (`application/errors`,
   * 422).
   */
  static create(id: string, createdBy: string, input: CreateBattleRoomInput, at: Date): BattleRoom {
    const roomId = BattleRoomId.create(id)
    const mode = parseBattleMode(input.mode)

    if (createdBy.trim().length === 0) {
      throw new DomainError('Una sala de batalla necesita un creador.')
    }

    if (input.teamConfigs.length !== 2) {
      throw new DomainError('Una sala de batalla necesita exactamente 2 equipos.')
    }

    const configA = input.teamConfigs[0]
    const configB = input.teamConfigs[1]

    if (configA === undefined || configB === undefined) {
      throw new DomainError('Una sala de batalla necesita exactamente 2 equipos.')
    }

    for (const [label, config] of [
      ['A', configA],
      ['B', configB],
    ] as const) {
      if (!Number.isInteger(config.capacity) || config.capacity < 1 || config.capacity > 3) {
        throw new InvalidTeamCapacityError(label, config.capacity)
      }
    }

    const totalCapacity = configA.capacity + configB.capacity

    // Defensa en profundidad, no alcanzable hoy por la API publica: con
    // exactamente 2 equipos y `capacity` ya acotada a 1..3 cada uno (arriba),
    // el maximo matematico es 3+3=6, el propio limite. Se conserva porque
    // RF-14/HU-14.1 declaran la regla "maximo 6 en total" como invariante
    // propia del agregado, no como una consecuencia derivada del numero de
    // equipos: si en el futuro cambia el numero de equipos o el tope por
    // equipo, esta comprobacion deja de ser redundante sin tocar el resto del
    // metodo. Ver HU-14.2-Informe-Correcciones-PostAuditoria.md, seccion H.
    if (totalCapacity > 6) {
      throw new InvalidRoomCapacityError(totalCapacity)
    }

    const teamA = Team.create('A', configA.capacity, configA.initialParticipants ?? [], at)
    const teamB = Team.create('B', configB.capacity, configB.initialParticipants ?? [], at)
    const teams: readonly [Team, Team] = [teamA, teamB]

    BattleRoom.validateModeComposition(mode, teams)

    const reward = RewardConfig.create(input.reward.amount)

    return new BattleRoom(
      roomId.value,
      mode,
      BattleRoomStatus.WaitingForPlayers,
      teams,
      reward,
      createdBy.trim(),
      at,
      0,
    )
  }

  /**
   * Reconstruye una sala desde persistencia. Solo comprobaciones
   * estructurales (`DomainError`): los datos ya pasaron las reglas de
   * negocio al escribirse.
   */
  static restore(snapshot: RestorableBattleRoomSnapshot): BattleRoom {
    const roomId = BattleRoomId.create(snapshot.id)
    const mode = parseBattleMode(snapshot.mode)
    const status = parseBattleRoomStatus(snapshot.status)

    if (snapshot.createdBy.trim().length === 0) {
      throw new DomainError('Una sala restaurada necesita un creador.')
    }
    if (Number.isNaN(snapshot.createdAt.getTime())) {
      throw new DomainError('La fecha de creacion restaurada no es valida.')
    }
    if (!Number.isInteger(snapshot.version) || snapshot.version < 0) {
      throw new DomainError('La version restaurada de la sala debe ser un entero no negativo.')
    }

    const teams: readonly [Team, Team] = [
      Team.restore(snapshot.teams[0]),
      Team.restore(snapshot.teams[1]),
    ]

    if (teams[0].capacity + teams[1].capacity > 6) {
      throw new DomainError('La capacidad total restaurada supera el maximo permitido (6).')
    }

    const reward = RewardConfig.create(snapshot.reward.amount)
    const battle =
      snapshot.battle === undefined || snapshot.battle === null
        ? null
        : BattleState.restore(snapshot.battle)
    const events = snapshot.events ?? []
    const handledCommands = snapshot.handledCommands ?? []
    const result = snapshot.result ?? null

    // Invariantes de HU-21 (contrato §12): la batalla existe si y solo si la
    // sala esta IN_BATTLE o FINISHED, y el resultado si y solo si esta FINISHED.
    const battleAllowed =
      status === BattleRoomStatus.InBattle || status === BattleRoomStatus.Finished

    if (battleAllowed !== (battle !== null)) {
      throw new DomainError(
        'Una sala IN_BATTLE o FINISHED necesita batalla, y una batalla solo existe en una de esas dos salas.',
      )
    }

    if ((status === BattleRoomStatus.Finished) !== (result !== null)) {
      throw new DomainError(
        'Una sala FINISHED necesita resultado, y un resultado solo existe en una sala FINISHED.',
      )
    }

    BattleRoom.assertConsistentEvents(events)

    return new BattleRoom(
      roomId.value,
      mode,
      status,
      teams,
      reward,
      snapshot.createdBy.trim(),
      snapshot.createdAt,
      snapshot.version,
      { battle, events, handledCommands, result },
    )
  }

  /**
   * Cancela la sala (RF-14: "hasta que ... el creador la cancele").
   * Precondicion: `requestedBy === createdBy` y `status ===
   * WAITING_FOR_PLAYERS` — HU-14.1, `HU-14.1-Decisiones-Tecnicas.md`, punto 7.
   * Devuelve un agregado nuevo con la MISMA version: quien la incrementa es
   * el repositorio al guardar con `expectedVersion` (mismo patron que
   * `HeroSelection.selectAnother`).
   */
  cancel(requestedBy: string): BattleRoom {
    if (requestedBy !== this.createdBy) {
      throw new RoomCancellationForbiddenError(this.id)
    }

    if (this.status !== BattleRoomStatus.WaitingForPlayers) {
      throw new RoomNotCancellableError(this.id, this.status)
    }

    return new BattleRoom(
      this.id,
      this.mode,
      BattleRoomStatus.Cancelled,
      this.teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
    )
  }

  /**
   * Une un jugador autenticado a la sala (HU-15.2, RF-15 — subconjunto
   * implementable segun `HU-15.2-Plan-Implementacion.md`, seccion 1.3/1.10).
   *
   * `playerId` es SIEMPRE `identity.subject` resuelto por el caso de uso
   * desde el testimonio verificado (nunca del cliente, mismo criterio que
   * `createdBy` en `create()`). `requestedTeam` es opcional: `null` dispara
   * asignacion automatica por el servidor (primer equipo del agregado, orden
   * `[A, B]`, con cupo disponible); si se declara, debe existir en la sala y
   * tener cupo, o se rechaza (nunca se asigna en silencio a otro equipo).
   * `at` viene de `ClockPort` resuelto por el caso de uso: nunca del cliente.
   *
   * `heroId`/`displayName` (HU-15.2, RF-15, DP-2/DP-4): PARAMETROS OPCIONALES
   * con valor por defecto `null`, resueltos SIEMPRE por `JoinBattleRoom` desde
   * los contratos internos de Player-Inventory y Account respectivamente
   * (nunca del cliente, mismo criterio que `playerId`/`at`). Son opcionales
   * en la FIRMA (no en el flujo real de `JoinBattleRoom`) para no romper
   * retrocompatibilidad binaria con quien ya invoca `join()` con 3
   * argumentos -- todas las pruebas de `HU-15.2` anteriores a esta ampliacion
   * siguen compilando y pasando sin modificarse.
   *
   * `heroLoadoutVersion` (HU-16.2, DP-6 de la auditoria HU-16.1): MISMO
   * criterio, parametro opcional adicional al final, `null` por defecto.
   * `JoinBattleRoom` lo resuelve SIEMPRE de `EquippedHero.loadoutVersion`
   * (Player-Inventory) antes de llamar, nunca del cliente. Captura la
   * version de equipamiento aprobada en el momento de unirse; no la
   * revalida (ver `Participant.heroLoadoutVersion`).
   *
   * Precondiciones, en orden: 1) `status === WAITING_FOR_PLAYERS`
   * (`RoomNotJoinableError`); 2) el jugador no es ya participante HUMAN de la
   * sala (`PlayerAlreadyJoinedError`, reutilizando la misma deteccion de
   * duplicado que `validateUniqueHumanPlayers` usa en `create()`); 3)
   * `displayName` (si no es `null`) no lo usa ya otro `HUMAN` de la sala,
   * comparacion insensible a mayusculas/espacios extremos
   * (`DuplicateDisplayNameError` -- DP-2); 4) el equipo objetivo (explicito o
   * resuelto automaticamente) tiene cupo (`RoomFullError`). Tras aplicar el
   * ingreso, EN LA MISMA MUTACION: si `totalParticipants() ===
   * totalCapacity()`, el estado pasa a `PREPARING`; si no, permanece
   * `WAITING_FOR_PLAYERS`.
   */
  join(
    playerId: string,
    requestedTeam: string | null,
    at: Date,
    displayName: string | null = null,
    heroId: string | null = null,
    heroLoadoutVersion: number | null = null,
  ): BattleRoom {
    if (this.status !== BattleRoomStatus.WaitingForPlayers) {
      throw new RoomNotJoinableError(this.id, this.status)
    }

    const participant = createParticipant(
      { kind: ParticipantKind.Human, playerId, heroId, heroLoadoutVersion, displayName },
      at,
    )
    const allParticipants = [...this.teams[0].participants, ...this.teams[1].participants]

    if (
      BattleRoom.findDuplicateHumanPlayerId([...allParticipants, participant]) !== null &&
      participant.playerId !== null
    ) {
      // La guarda `participant.playerId !== null` es defensa en profundidad
      // de tipos, no una regla de negocio nueva: `createParticipant()` ya
      // exige `playerId` para `ParticipantKind.Human` (lo contrario lanza
      // `DomainError` antes de llegar aqui), asi que esta rama siempre se
      // cumple en la practica; permite narrowing sin asercion de tipos.
      throw new PlayerAlreadyJoinedError(this.id, participant.playerId)
    }

    if (participant.displayName !== null) {
      const normalized = participant.displayName.trim().toLowerCase()
      const collides = allParticipants.some(
        (existing) =>
          existing.displayName !== null && existing.displayName.trim().toLowerCase() === normalized,
      )

      if (collides) {
        throw new DuplicateDisplayNameError(this.id, participant.displayName)
      }
    }

    const targetIndex = BattleRoom.resolveTargetTeamIndex(this.teams, requestedTeam, this.id)
    const updatedTeam = this.teams[targetIndex].withParticipant(participant)
    const teams: readonly [Team, Team] =
      targetIndex === 0 ? [updatedTeam, this.teams[1]] : [this.teams[0], updatedTeam]

    const totalParticipants = teams[0].totalParticipants + teams[1].totalParticipants
    const nextStatus =
      totalParticipants === this.totalCapacity() ? BattleRoomStatus.Preparing : this.status

    return new BattleRoom(
      this.id,
      this.mode,
      nextStatus,
      teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
    )
  }

  /**
   * Un participante `HUMAN` abandona la sala (ciclo de vida del lobby,
   * HU-15.2): libera su cupo. Aplica al propietario igual que a cualquier
   * otro participante -- abandonar es distinto de `cancel()` (que es
   * exclusivo de `createdBy` y afecta a la sala entera, no a un cupo
   * individual); `createdBy` no cambia solo porque el creador deje de
   * ocupar un puesto.
   *
   * Precondiciones, en orden, mismo criterio de "estado antes que
   * pertenencia" que `join()`: 1) `status !== CANCELLED`
   * (`RoomNotLeavableError` -- una sala cancelada ya no tiene participantes
   * que gestionar); 2) el `playerId` es HUMAN participante de ALGUN equipo
   * (`PlayerNotInRoomError` si no).
   *
   * Efecto sobre el estado: si la sala estaba `PREPARING` (llena) y este
   * abandono libera un cupo, vuelve a `WAITING_FOR_PLAYERS` en la MISMA
   * mutacion -- simetrico a como `join()` transiciona a `PREPARING` al
   * completar el cupo total.
   */
  leave(playerId: string): BattleRoom {
    // HU-17: con la batalla en curso la lista de participantes es definitiva
    // (RF-17): abandonar el lobby cambiaria el roster de una cola ya publicada.
    // HU-21: una sala FINISHED es terminal; tampoco admite `leave` (contrato §2).
    if (
      this.status === BattleRoomStatus.Cancelled ||
      this.status === BattleRoomStatus.InBattle ||
      this.status === BattleRoomStatus.Finished
    ) {
      throw new RoomNotLeavableError(this.id, this.status)
    }

    const isMember = (team: Team): boolean =>
      team.participants.some(
        (participant) =>
          participant.kind === ParticipantKind.Human && participant.playerId === playerId,
      )

    let teams: readonly [Team, Team]

    if (isMember(this.teams[0])) {
      teams = [this.teams[0].withoutParticipant(playerId), this.teams[1]]
    } else if (isMember(this.teams[1])) {
      teams = [this.teams[0], this.teams[1].withoutParticipant(playerId)]
    } else {
      throw new PlayerNotInRoomError(this.id, playerId)
    }

    const totalParticipants = teams[0].totalParticipants + teams[1].totalParticipants
    const nextStatus =
      this.status === BattleRoomStatus.Preparing && totalParticipants < this.totalCapacity()
        ? BattleRoomStatus.WaitingForPlayers
        : this.status

    return new BattleRoom(
      this.id,
      this.mode,
      nextStatus,
      teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
    )
  }

  get version(): number {
    return this._version
  }

  totalCapacity(): number {
    return this.teams[0].capacity + this.teams[1].capacity
  }

  totalParticipants(): number {
    return this.teams[0].totalParticipants + this.teams[1].totalParticipants
  }

  /**
   * NO se persiste como campo booleano: se deriva al leer, para no duplicar
   * el cupo real (HU-14.1, `HU-14.1-Contrato-Creacion-Sala.md`, seccion 2).
   */
  isAvailable(): boolean {
    return (
      this.status === BattleRoomStatus.WaitingForPlayers &&
      this.totalParticipants() < this.totalCapacity()
    )
  }

  toSnapshot(): BattleRoomSnapshot {
    return {
      id: this.id,
      mode: this.mode,
      status: this.status,
      teams: [this.teams[0].toSnapshot(), this.teams[1].toSnapshot()],
      reward: this.reward.toSnapshot(),
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      version: this._version,
      battle: this.battle === null ? null : this.battle.toSnapshot(),
      events: this.events,
      handledCommands: this.handledCommands,
      result: this.result,
    }
  }

  /** `seq` del ultimo evento de batalla (0 si todavia no hay ninguno). */
  get lastSeq(): number {
    return this.events.length
  }

  /**
   * Vista de la batalla visible para los participantes, o `null` sin batalla.
   * Una sala FINISHED devuelve la vista final SIN `deadlines` (contrato §6.2 y
   * §6.3); una batalla en curso los incluye.
   */
  battleView(): BattleView | null {
    return this.battle === null
      ? null
      : this.battle.toView(this.id, {
          withDeadlines: this.status !== BattleRoomStatus.Finished,
        })
  }

  /** `true` si el `commandId` ya se proceso en esta sala (ADR-020). */
  hasHandledCommand(commandId: string): boolean {
    return this.handledCommands.some((handled) => handled.commandId === commandId)
  }

  /** Eventos con `seq` estrictamente mayor que `seq`, en orden. */
  eventsAfter(seq: number): readonly BattleEvent[] {
    return this.events.filter((event) => event.seq > seq)
  }

  /** `true` si `playerId` es un participante HUMAN de la sala. */
  isParticipant(playerId: string): boolean {
    return [...this.teams[0].participants, ...this.teams[1].participants].some(
      (participant) =>
        participant.kind === ParticipantKind.Human && participant.playerId === playerId,
    )
  }

  /**
   * Lista definitiva de participantes por equipo (HU-17): la ENTRADA de la
   * generacion de la cola. `heroSubtype` queda en `null`: lo aporta la capa de
   * aplicacion desde Player-Inventory al iniciar. Ningun dato de estadisticas
   * o equipamiento pasa por aqui.
   */
  roster(): readonly [TeamRoster, TeamRoster] {
    const rosterOf = (team: Team): TeamRoster => ({
      label: team.label,
      members: team.participants.map((participant, seat) => ({
        teamLabel: team.label,
        seat,
        kind: participant.kind,
        playerId: participant.playerId,
        displayName: participant.displayName,
        heroId: participant.heroId,
        heroSubtype: null,
      })),
    })

    return [rosterOf(this.teams[0]), rosterOf(this.teams[1])]
  }

  /**
   * Inicia la batalla (HU-17, RF-17) con la cola YA generada: `PREPARING ->
   * IN_BATTLE`, registra `battleStarted` con `seq = 1` y deja el turno activo
   * en la posicion 0. La cola debe corresponder EXACTAMENTE a la lista
   * definitiva de la sala (ningun participante externo, ninguno omitido).
   *
   * Devuelve un agregado nuevo con la MISMA version: quien la incrementa es el
   * repositorio al guardar con `expectedVersion`.
   */
  startBattle(
    turnOrder: readonly TurnOrderEntry[],
    at: Date,
    combatants: readonly Combatant[] | null = null,
  ): BattleRoom {
    if (this.status !== BattleRoomStatus.Preparing) {
      throw new RoomNotStartableError(this.id, this.status)
    }

    if (this.totalParticipants() !== this.totalCapacity()) {
      throw new RoomNotStartableError(this.id, this.status)
    }

    BattleRoom.assertQueueMatchesRoster(this.roster(), turnOrder)

    const battle = BattleState.start(turnOrder, at, combatants)
    const event: BattleEvent = {
      seq: 1,
      type: BattleEventType.BattleStarted,
      occurredAt: at,
      payload: { battle: battle.toView(this.id) },
    }

    return new BattleRoom(
      this.id,
      this.mode,
      BattleRoomStatus.InBattle,
      this.teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
      { battle, events: [event], handledCommands: [] },
    )
  }

  /**
   * Cierra el turno activo y avanza al siguiente elemento de la cola (HU-17,
   * RF-17). Lo invoca EL SERVIDOR al terminar una accion valida (HU-18/19); no
   * es una operacion que un cliente pueda pedir por si misma.
   *
   * `actorPlayerId` debe ser el participante de la posicion activa (`null`
   * cuando el turno activo es de un `AI`, que lo cierra el servidor). Un
   * `commandId` ya procesado devuelve ESTA MISMA instancia (`next === this`):
   * el llamante lo detecta y no persiste ni difunde nada (ADR-020).
   */
  completeTurn(actorPlayerId: string | null, commandId: string, at: Date): BattleRoom {
    BattleRoom.assertValidCommandId(commandId)

    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    if (this.handledCommands.some((handled) => handled.commandId === commandId)) {
      return this
    }

    const current = this.battle.currentEntry
    const isActor =
      current.kind === ParticipantKind.Human
        ? actorPlayerId !== null && actorPlayerId === current.playerId
        : actorPlayerId === null

    if (!isActor) {
      throw new NotYourTurnError(this.id)
    }

    const completedPosition = this.battle.currentPosition
    const battle = this.battle.completeTurn(at)
    const seq = this.lastSeq + 1
    const event: BattleEvent = {
      seq,
      type: BattleEventType.TurnAdvanced,
      occurredAt: at,
      payload: { completedPosition, battle: battle.toView(this.id) },
    }

    return new BattleRoom(
      this.id,
      this.mode,
      this.status,
      this.teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
      {
        battle,
        events: [...this.events, event],
        handledCommands: [...this.handledCommands, { commandId, seq }],
      },
    )
  }

  /**
   * Valida un ataque basico SIN aleatoriedad (HU-18, contrato v1 §3). El orden es el
   * del contrato: `commandId` -> repeticion -> batalla activa -> turno -> objetivo
   * existe -> objetivo de otro equipo -> perfiles y Vida -> Ataque y Dano soportados.
   * Cualquier fallo lanza y no cambia nada; ninguno consume un solo sorteo.
   *
   * Un `commandId` ya procesado devuelve `replay` con el evento persistido: se
   * comprueba ANTES del turno porque tras el ataque el turno ya no es del atacante
   * y el reintento no debe fallar por eso.
   *
   * La identidad del atacante es SIEMPRE `actorPlayerId` (el `sub` autenticado) y
   * el turno vigente; nunca un dato del cliente.
   */
  planBasicAttack(actorPlayerId: string, commandId: string, target: CombatantKey): BasicAttackPlan {
    BattleRoom.assertValidCommandId(commandId)

    const replay = this.replayOf(commandId)

    if (replay !== null) {
      return replay
    }

    const context = this.requireCombatContext(actorPlayerId, target)

    if (context.attackerProfile.attack === null) {
      throw new UnsupportedCombatProfileError('el heroe no tiene un valor de Ataque numerico.')
    }

    return {
      kind: 'ready',
      ...context,
      damage: assertSupportedDamage(context.attackerProfile.damage),
    }
  }

  /** El evento ya persistido de un `commandId` procesado, o `null` si es un comando nuevo. */
  private replayOf(commandId: string): BasicAttackReplay | null {
    const handled = this.handledCommands.find((candidate) => candidate.commandId === commandId)

    if (handled === undefined) {
      return null
    }

    const event = this.events.find((candidate) => candidate.seq === handled.seq)

    if (event === undefined) {
      throw new DomainError('El comando procesado no tiene su evento en la bitacora de la sala.')
    }

    return { kind: 'replay', event }
  }

  /**
   * Lo que comparten el ataque basico y la habilidad (HU-18/HU-19), en este orden y sin
   * sortear: batalla en curso, turno del solicitante, objetivo existente y enemigo,
   * snapshot de combate, perfiles y Vida de ambos. Cualquier fallo lanza y no cambia nada.
   */
  private requireCombatContext(
    actorPlayerId: string,
    target: CombatantKey,
  ): {
    readonly attackerEntry: TurnOrderEntry
    readonly targetEntry: TurnOrderEntry
    readonly attacker: Combatant
    readonly target: Combatant
    readonly attackerProfile: CombatProfile
    readonly targetProfile: CombatProfile
    readonly targetHealth: number
  } {
    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    const attackerEntry = this.battle.currentEntry

    if (attackerEntry.kind !== ParticipantKind.Human || attackerEntry.playerId !== actorPlayerId) {
      throw new NotYourTurnError(this.id)
    }

    const targetEntry = this.battle.turnOrder.find(
      (entry) => entry.teamLabel === target.teamLabel && entry.seat === target.seat,
    )

    if (targetEntry === undefined) {
      throw new InvalidTargetError(this.id)
    }

    if (targetEntry.teamLabel === attackerEntry.teamLabel) {
      throw new SameTeamTargetError()
    }

    if (this.battle.combatants === null) {
      throw new UnsupportedCombatProfileError(
        'la batalla comenzo antes de habilitar el ataque basico y no tiene snapshot de combate.',
      )
    }

    const attacker = this.battle.combatantFor(attackerEntry)
    const targetCombatant = this.battle.combatantFor(targetEntry)

    if (attacker === undefined || targetCombatant === undefined) {
      throw new DomainError('El snapshot de combate no contiene a los participantes del golpe.')
    }

    if (attacker.profile === null || attacker.currentHealth === null) {
      throw new UnsupportedCombatProfileError('el atacante no tiene perfil de combate.')
    }

    if (targetCombatant.profile === null || targetCombatant.currentHealth === null) {
      throw new UnsupportedCombatProfileError('el objetivo no tiene perfil de combate.')
    }

    if (!attacker.alive) {
      throw new ActorUnavailableError()
    }

    if (!targetCombatant.alive) {
      throw new TargetUnavailableError()
    }

    return {
      attackerEntry,
      targetEntry,
      attacker,
      target: targetCombatant,
      attackerProfile: attacker.profile,
      targetProfile: targetCombatant.profile,
      targetHealth: targetCombatant.currentHealth,
    }
  }

  /**
   * Aplica un ataque basico ya resuelto como UNA sola transicion del agregado
   * (HU-18): Vida del objetivo + evento con su `seq` + `commandId` procesado + turno
   * avanzado, en una unica version nueva. Quien la persiste hace UNA escritura:
   * nunca puede quedar la Vida bajada con el turno sin avanzar, ni el turno
   * avanzado sin resultado.
   *
   * `dano calculado = floor(dano base x porcentaje / 100)` (aclaracion formal,
   * Management #62) y `dano aplicado = min(dano calculado, Vida)`: la Vida no baja
   * de 0. Un golpe no efectivo o con efecto 0 % no cambia la Vida y el turno
   * igualmente avanza. La regla de avance es la de HU-17 (`BattleState.completeTurn`).
   */
  applyBasicAttack(
    plan: BasicAttackReadyPlan,
    outcome: BasicAttackOutcome,
    commandId: string,
    at: Date,
    degradedFrom?: DegradedFrom,
  ): BattleRoom {
    BattleRoom.assertValidCommandId(commandId)

    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    if (
      !outcome.effective &&
      (outcome.effect !== null || outcome.percent !== null || outcome.baseDamage !== null)
    ) {
      throw new DomainError('Un golpe no efectivo no produce efecto, porcentaje ni dano base.')
    }

    const calculatedDamage =
      outcome.effective && outcome.percent !== null && outcome.baseDamage !== null
        ? calculateDamage(outcome.baseDamage, outcome.percent)
        : 0
    const applied = applyDamage(plan.targetHealth, calculatedDamage)
    const completedPosition = this.battle.currentPosition
    const battle = this.battle
      .withCombatant(plan.target.withHealth(applied.healthAfter))
      .completeTurn(at)
    const seq = this.lastSeq + 1
    const event: BattleEvent = {
      seq,
      type: BattleEventType.BasicAttackResolved,
      occurredAt: at,
      payload: {
        commandId,
        completedPosition,
        attacker: { teamLabel: plan.attackerEntry.teamLabel, seat: plan.attackerEntry.seat },
        target: { teamLabel: plan.targetEntry.teamLabel, seat: plan.targetEntry.seat },
        resolution: {
          attackValue: outcome.attackValue,
          defenseValue: outcome.defenseValue,
          effective: outcome.effective,
          effect: outcome.effect,
          percent: outcome.percent,
          baseDamage: outcome.baseDamage,
          calculatedDamage: applied.calculatedDamage,
          appliedDamage: applied.appliedDamage,
        },
        targetHealth: { before: applied.healthBefore, after: applied.healthAfter },
        ...(degradedFrom === undefined ? {} : { degradedFrom }),
        battle: battle.toView(this.id),
      },
    }

    const next = new BattleRoom(
      this.id,
      this.mode,
      this.status,
      this.teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
      {
        battle,
        events: [...this.events, event],
        handledCommands: [...this.handledCommands, { commandId, seq }],
      },
    )

    // HU-21 (contrato §4.1): la eliminacion se evalua EN ESTA MISMA escritura,
    // sobre la sala que ya trae el evento de la accion. Si un equipo quedo sin
    // heroes, la sala vuelve FINISHED con `battleFinished` de `seq` contiguo.
    return next.concludeIfEliminated(plan.attackerEntry.teamLabel, at)
  }

  /**
   * Valida una habilidad especial (HU-19, contrato `hu-19-skills-v1`, §3) ANTES de consumir
   * un solo sorteo. Orden: `commandId` (forma), repeticion, batalla, turno, objetivo,
   * perfiles y Vida (los mismos de `attack`), estado de habilidades, habilidad del heroe
   * (CA-02), efectos soportados, recarga (CA-04, CA-07) y, al final, el Poder (CA-03).
   *
   * Poder insuficiente NO es un error: HU-11 exige forzar el ataque basico en ese turno, asi
   * que se devuelve `degraded` y el llamador ejecuta un ataque basico contra el mismo
   * objetivo, con el Poder y la recarga intactos. Una habilidad que el sistema no sabe
   * ejecutar se rechaza ANTES de hablar de Poder: no se fuerza un ataque por ella.
   *
   * La identidad del actor es SIEMPRE `actorPlayerId` (el `sub` autenticado) y el turno
   * vigente; la habilidad y su costo salen del snapshot congelado, nunca del cliente.
   */
  planSkill(
    actorPlayerId: string,
    commandId: string,
    abilityId: string,
    target: CombatantKey,
  ): SkillPlan {
    BattleRoom.assertValidCommandId(commandId)

    const replay = this.replayOf(commandId)

    if (replay !== null) {
      return replay
    }

    const context = this.requireCombatContext(actorPlayerId, target)
    const { attacker, attackerProfile } = context
    const maxPower = attackerProfile.maxPower

    if (maxPower === undefined || attacker.currentPower === null || !attacker.hasSkillState) {
      throw new SkillsNotAvailableError()
    }

    const ability = attacker.abilities.find((candidate) => candidate.abilityId === abilityId)

    if (ability === undefined) {
      throw new UnknownSkillError()
    }

    const support = evaluateSkill(ability)

    if (!support.supported) {
      throw new UnsupportedSkillEffectError(support.reason)
    }

    if (attacker.cooldownOf(abilityId) > 0) {
      throw new SkillOnCooldownError()
    }

    const payment = spendPower(
      { heroId: memberKey(context.attackerEntry), current: attacker.currentPower, max: maxPower },
      ability.powerCost,
    )

    if (!payment.ok) {
      return { kind: 'degraded', abilityId }
    }

    if (attackerProfile.attack === null) {
      throw new UnsupportedCombatProfileError('el heroe no tiene un valor de Ataque numerico.')
    }

    return {
      kind: 'skill',
      ...context,
      damage: assertSupportedDamage(attackerProfile.damage),
      ability,
      attackBonus: support.attackBonus,
      damageBonus: support.damageBonus,
      powerBefore: attacker.currentPower,
      powerAfter: payment.state.current,
    }
  }

  /**
   * Aplica una habilidad ya resuelta como UNA sola transicion del agregado (HU-19, mismo
   * criterio que `applyBasicAttack`): Vida del objetivo + Poder del actor + recarga + evento
   * con su `seq` + `commandId` procesado + turno avanzado, en una unica version nueva.
   * Quien la persiste hace UNA escritura: no puede quedar el Poder descontado sin el golpe,
   * ni la recarga marcada sin el evento.
   *
   * La recarga se marca con `chargeTurns + 1` y el cierre del turno propio (`completeTurn`)
   * descuenta uno: tras la accion queda `chargeTurns`, y con el turno siguiente del actor
   * sigue bloqueada (`hu-19-skills-v1` §5.3). El siguiente participante recibe +2 de Poder
   * en esa misma transicion.
   */
  applySkill(plan: SkillReadyPlan, outcome: SkillOutcome, commandId: string, at: Date): BattleRoom {
    BattleRoom.assertValidCommandId(commandId)

    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    if (
      !outcome.effective &&
      (outcome.effect !== null ||
        outcome.percent !== null ||
        outcome.baseDamage !== null ||
        outcome.damageBonus !== null)
    ) {
      throw new DomainError('Un golpe no efectivo no produce efecto, porcentaje ni dano base.')
    }

    const calculatedDamage =
      outcome.effective && outcome.percent !== null && outcome.baseDamage !== null
        ? calculateDamage(outcome.baseDamage, outcome.percent)
        : 0
    const applied = applyDamage(plan.targetHealth, calculatedDamage)
    const completedPosition = this.battle.currentPosition
    const actor = plan.attacker
      .withPower(plan.powerAfter)
      .withCooldown(plan.ability.abilityId, plan.ability.chargeTurns + 1)
    const battle = this.battle
      .withCombatant(actor)
      .withCombatant(plan.target.withHealth(applied.healthAfter))
      .completeTurn(at)
    const seq = this.lastSeq + 1
    const event: BattleEvent = {
      seq,
      type: BattleEventType.SkillUsed,
      occurredAt: at,
      payload: {
        commandId,
        completedPosition,
        actor: { teamLabel: plan.attackerEntry.teamLabel, seat: plan.attackerEntry.seat },
        target: { teamLabel: plan.targetEntry.teamLabel, seat: plan.targetEntry.seat },
        skill: {
          abilityId: plan.ability.abilityId,
          name: plan.ability.name,
          powerCost: plan.ability.powerCost,
          chargeTurns: plan.ability.chargeTurns,
        },
        power: { before: plan.powerBefore, after: plan.powerAfter },
        cooldown: {
          remainingTurns:
            battle.combatantFor(plan.attackerEntry)?.cooldownOf(plan.ability.abilityId) ?? 0,
        },
        bonus: { attack: outcome.attackBonus, damage: outcome.damageBonus },
        resolution: {
          attackValue: outcome.attackValue,
          defenseValue: outcome.defenseValue,
          effective: outcome.effective,
          effect: outcome.effect,
          percent: outcome.percent,
          baseDamage: outcome.baseDamage,
          calculatedDamage: applied.calculatedDamage,
          appliedDamage: applied.appliedDamage,
        },
        targetHealth: { before: applied.healthBefore, after: applied.healthAfter },
        battle: battle.toView(this.id),
      },
    }

    const next = new BattleRoom(
      this.id,
      this.mode,
      this.status,
      this.teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
      {
        battle,
        events: [...this.events, event],
        handledCommands: [...this.handledCommands, { commandId, seq }],
      },
    )

    // HU-21 (mismo criterio que `applyBasicAttack`): una habilidad tambien puede
    // dejar a un equipo sin heroes, y lo hace en esta misma escritura.
    return next.concludeIfEliminated(plan.attackerEntry.teamLabel, at)
  }

  /**
   * Finaliza la batalla (HU-21, contrato §4 y §7) y devuelve la sala FINISHED
   * con el resultado unico, el Poder restaurado (HU-11) y el evento
   * `battleFinished`. Es IDEMPOTENTE: sobre una sala ya FINISHED devuelve esta
   * misma instancia, sin segundo resultado ni segundo evento. Desde cualquier
   * otro estado distinto de IN_BATTLE lanza `BattleNotInProgressError`.
   *
   * Una sola escritura: estado, `result`, Poder, evento y version viajan juntos
   * (la version la incrementa el repositorio al guardar, como hoy). La vista
   * final NO lleva `deadlines` (contrato §6.2).
   */
  finish(cause: FinishCause, at: Date): BattleRoom {
    if (this.status === BattleRoomStatus.Finished) {
      return this
    }

    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    const labels: readonly [string, string] = [this.teams[0].label, this.teams[1].label]
    const lives = teamLives(this.battle.combatants, labels)
    const outcome = this.resolveOutcome(cause, labels, lives)
    const battle = this.battle.restoreAllPower()
    const result: BattleResult = {
      reason: cause.reason,
      outcome: outcome.outcome,
      winnerTeamLabel: outcome.winnerTeamLabel,
      finishedAt: at.toISOString(),
      tiebreak: outcome.tiebreak,
      disconnected:
        cause.reason === 'DISCONNECTION'
          ? { teamLabel: cause.disconnected.teamLabel, seat: cause.disconnected.seat }
          : null,
      teams: [standingOf(lives[0]), standingOf(lives[1])],
      participants: participantOutcomes(
        this.battle.turnOrder,
        outcome.outcome,
        outcome.winnerTeamLabel,
      ),
    }
    const seq = this.lastSeq + 1
    const event: BattleEvent = {
      seq,
      type: BattleEventType.BattleFinished,
      occurredAt: at,
      payload: { result, battle: battle.toView(this.id, { withDeadlines: false }) },
    }

    return new BattleRoom(
      this.id,
      this.mode,
      BattleRoomStatus.Finished,
      this.teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
      {
        battle,
        events: [...this.events, event],
        handledCommands: this.handledCommands,
        result,
      },
    )
  }

  /**
   * Si algun equipo quedo sin heroes, finaliza por eliminacion (contrato §4.1).
   * Lo invocan `applyBasicAttack` y `applySkill` al final, sobre la sala nueva
   * que ya incluye su evento: asi el evento de la accion y `battleFinished`
   * quedan en la MISMA escritura y con `seq` consecutivos.
   */
  private concludeIfEliminated(actorTeamLabel: string, at: Date): BattleRoom {
    if (this.battle === null || this.status !== BattleRoomStatus.InBattle) {
      return this
    }

    const labels: readonly [string, string] = [this.teams[0].label, this.teams[1].label]
    const eliminated = findEliminatedTeam(teamLives(this.battle.combatants, labels))

    // Sin eliminacion, o con el propio equipo del actor eliminado (imposible con
    // las reglas de HU-18/19: el actor esta vivo y no se ataca a un aliado), la
    // batalla sigue.
    if (eliminated === null || eliminated === actorTeamLabel) {
      return this
    }

    return this.finish({ reason: 'ELIMINATION', winnerTeamLabel: actorTeamLabel }, at)
  }

  /**
   * Traduce la causa al par (outcome, ganador, desempate) del contrato §4:
   * eliminacion y desconexion siempre tienen ganador; el vencimiento global lo
   * resuelve `BattleOutcomePolicy` (porcentaje, vida absoluta o `NO_WINNER`).
   */
  private resolveOutcome(
    cause: FinishCause,
    labels: readonly [string, string],
    lives: readonly [TeamLife, TeamLife],
  ): {
    readonly outcome: BattleOutcome
    readonly winnerTeamLabel: string | null
    readonly tiebreak: TiebreakRule | null
  } {
    if (cause.reason === 'ELIMINATION') {
      if (!labels.includes(cause.winnerTeamLabel)) {
        throw new DomainError('El ganador por eliminacion debe ser uno de los equipos de la sala.')
      }

      return { outcome: 'WIN', winnerTeamLabel: cause.winnerTeamLabel, tiebreak: null }
    }

    if (cause.reason === 'DISCONNECTION') {
      const rival = labels.find((label) => label !== cause.disconnected.teamLabel)

      if (rival === undefined) {
        throw new DomainError('El desconectado debe pertenecer a uno de los equipos de la sala.')
      }

      return { outcome: 'WIN', winnerTeamLabel: rival, tiebreak: null }
    }

    const resolution = resolveTimeLimit(lives[0], lives[1])

    return resolution.winnerTeamLabel === null
      ? { outcome: 'NO_WINNER', winnerTeamLabel: null, tiebreak: null }
      : {
          outcome: 'WIN',
          winnerTeamLabel: resolution.winnerTeamLabel,
          tiebreak: resolution.tiebreak,
        }
  }

  /**
   * Liquida los vencimientos pendientes de la sala (HU-21, contrato §3 y §4.5).
   * PURO y de UNA sola transicion por llamada: si vence la gracia de un
   * participante ausente finaliza por desconexion; si vence el global, por
   * tiempo; si vence el turno, publica `turnTimedOut` y avanza. Cuando hay
   * varios vencimientos elige el MAS ANTIGUO; en empate exacto:
   * DISCONNECTION > TIME_LIMIT > turno.
   */
  settleDeadlines(now: Date, absences: ReadonlyMap<string, Date>): BattleRoom {
    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      return this
    }

    const expiry = this.oldestExpiry(now, absences)

    if (expiry === null) {
      return this
    }

    if (expiry.kind === 'grace') {
      return this.finish({ reason: 'DISCONNECTION', disconnected: expiry.key }, now)
    }

    if (expiry.kind === 'global') {
      return this.finish({ reason: 'TIME_LIMIT' }, now)
    }

    const completedPosition = this.battle.currentPosition
    const timedOut = this.battle.currentEntry
    const battle = this.battle.completeTurn(now)
    const seq = this.lastSeq + 1
    const event: BattleEvent = {
      seq,
      type: BattleEventType.TurnTimedOut,
      occurredAt: now,
      payload: {
        completedPosition,
        timedOut: { teamLabel: timedOut.teamLabel, seat: timedOut.seat },
        battle: battle.toView(this.id),
      },
    }

    return new BattleRoom(
      this.id,
      this.mode,
      this.status,
      this.teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
      {
        battle,
        events: [...this.events, event],
        // El vencimiento del turno NO consume comandos: no toca `handledCommands`.
        handledCommands: this.handledCommands,
      },
    )
  }

  /**
   * Instante del vencimiento mas inminente (global, turno o gracia de un
   * ausente), o `null` fuera de `IN_BATTLE`. Es lo que el planificador registra
   * para despertar solo cuando haga falta.
   */
  nextDueAt(absences: ReadonlyMap<string, Date>): Date | null {
    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      return null
    }

    const deadlines: Date[] = [
      battleDeadline(this.battle.startedAt),
      turnDeadline(this.battle.turnStartedAt),
    ]

    for (const entry of this.battle.turnOrder) {
      if (entry.kind !== ParticipantKind.Human || entry.playerId === null) {
        continue
      }

      const since = absences.get(entry.playerId)

      if (since !== undefined) {
        deadlines.push(graceDeadline(since))
      }
    }

    let earliest: Date | null = null

    for (const deadline of deadlines) {
      if (earliest === null || deadline.getTime() < earliest.getTime()) {
        earliest = deadline
      }
    }

    return earliest
  }

  /**
   * El vencimiento mas antiguo entre los candidatos (contrato §4.5). En empate
   * exacto manda la prioridad de la causa: desconexion, luego tiempo global,
   * luego turno. Entre varias gracias con el mismo vencimiento gana la primera
   * de la cola (y como el vencimiento es `ausenteDesde + 30 s`, eso es
   * exactamente el `desconectadoDesde` mas antiguo, con la posicion menor como
   * desempate).
   */
  private oldestExpiry(now: Date, absences: ReadonlyMap<string, Date>): Expiry | null {
    if (this.battle === null) {
      return null
    }

    const candidates: Expiry[] = []

    for (const entry of this.battle.turnOrder) {
      if (entry.kind !== ParticipantKind.Human || entry.playerId === null) {
        continue
      }

      const since = absences.get(entry.playerId)

      if (since === undefined) {
        continue
      }

      const at = graceDeadline(since)

      if (hasReached(now, at)) {
        candidates.push({
          kind: 'grace',
          at,
          key: { teamLabel: entry.teamLabel, seat: entry.seat },
        })
      }
    }

    const global = battleDeadline(this.battle.startedAt)

    if (hasReached(now, global)) {
      candidates.push({ kind: 'global', at: global })
    }

    const turn = turnDeadline(this.battle.turnStartedAt)

    if (hasReached(now, turn)) {
      candidates.push({ kind: 'turn', at: turn })
    }

    let oldest: Expiry | null = null

    for (const candidate of candidates) {
      if (oldest === null) {
        oldest = candidate
        continue
      }

      const difference = candidate.at.getTime() - oldest.at.getTime()

      if (
        difference < 0 ||
        (difference === 0 && expiryPriority(candidate) < expiryPriority(oldest))
      ) {
        oldest = candidate
      }
    }

    return oldest
  }

  private static assertValidCommandId(commandId: string): void {
    if (
      typeof commandId !== 'string' ||
      commandId.trim().length === 0 ||
      commandId.length > MAX_COMMAND_ID_LENGTH
    ) {
      throw new InvalidCommandIdError()
    }
  }

  private static assertConsistentEvents(events: readonly BattleEvent[]): void {
    events.forEach((event, index) => {
      if (event.seq !== index + 1) {
        throw new DomainError(
          'La bitacora de eventos de la sala no es una secuencia 1..n sin huecos.',
        )
      }
    })
  }

  /** La cola debe ser EXACTAMENTE la lista definitiva: mismos participantes, ni uno mas ni uno menos. */
  private static assertQueueMatchesRoster(
    rosters: readonly [TeamRoster, TeamRoster],
    turnOrder: readonly TurnOrderEntry[],
  ): void {
    const expected = new Map(
      rosters.flatMap((roster) => roster.members).map((member) => [memberKey(member), member]),
    )

    if (turnOrder.length !== expected.size) {
      throw new InvalidBattleRosterError(
        'La cola de turnos no contiene exactamente a los participantes de la sala.',
      )
    }

    for (const entry of turnOrder) {
      const member = expected.get(memberKey(entry))

      if (member?.kind !== entry.kind || member.playerId !== entry.playerId) {
        throw new InvalidBattleRosterError(
          `El participante ${memberKey(entry)} de la cola no pertenece a la sala.`,
        )
      }

      expected.delete(memberKey(entry))
    }
  }

  private static validateModeComposition(mode: BattleMode, teams: readonly [Team, Team]): void {
    const participants = [...teams[0].participants, ...teams[1].participants]

    BattleRoom.validateUniqueHumanPlayers(participants)

    if (participants.length === 0) {
      // La sala nace esperando jugadores (CA-01): sin participantes
      // declarados no hay composicion que evaluar.
      return
    }

    const hasAi = participants.some((participant) => participant.kind === ParticipantKind.Ai)

    if (mode === BattleMode.Pvp && hasAi) {
      throw new InvalidModeCompositionError('Una sala PVP no admite ningun participante AI.')
    }

    if (mode === BattleMode.Pve && !hasAi) {
      throw new InvalidModeCompositionError(
        'Una sala PVE con participantes declarados exige que al menos uno sea AI.',
      )
    }
  }

  /**
   * Un `HUMAN` representa a UN jugador. `CreateBattleRoom` resuelve siempre
   * `playerId = createdBy` para todo `HUMAN` declarado por el cliente (el DTO
   * no acepta `playerId`), asi que sin esta comprobacion el mismo jugador
   * podria "ocupar" 2+ puestos contados en `totalParticipants()`/
   * `isAvailable()` sin que exista una segunda persona real. HU-14.1 no lo
   * declara como invariante explicita, pero permitirlo produce una
   * composicion imposible (una persona no ocupa dos asientos a la vez), asi
   * que se reutiliza `InvalidModeCompositionError` en vez de inventar una
   * clase nueva fuera del catalogo aprobado.
   *
   * Refactor HU-15.2: la busqueda del duplicado se extrajo a
   * `findDuplicateHumanPlayerId` (sin lanzar) para que `join()` pueda
   * reutilizar EXACTAMENTE la misma deteccion y decidir su propio error
   * (`PlayerAlreadyJoinedError`, semanticamente distinto de "composicion
   * invalida al crear") sin duplicar el bucle. Ver
   * `HU-15.2-Auditoria-Entrada.md`, pregunta 12.
   */
  private static validateUniqueHumanPlayers(participants: readonly Participant[]): void {
    const duplicate = BattleRoom.findDuplicateHumanPlayerId(participants)

    if (duplicate !== null) {
      throw new InvalidModeCompositionError(
        `El jugador "${duplicate}" no puede ocupar mas de un puesto HUMAN en la misma sala.`,
      )
    }
  }

  /** Devuelve el primer `playerId` HUMAN repetido en la lista, o `null` si no hay ninguno. */
  private static findDuplicateHumanPlayerId(participants: readonly Participant[]): string | null {
    const seenPlayerIds = new Set<string>()

    for (const participant of participants) {
      if (participant.kind !== ParticipantKind.Human || participant.playerId === null) {
        continue
      }

      if (seenPlayerIds.has(participant.playerId)) {
        return participant.playerId
      }

      seenPlayerIds.add(participant.playerId)
    }

    return null
  }

  /**
   * Resuelve el indice del equipo objetivo de un `join()` (HU-15.2, DP-1).
   *
   * Con `requestedTeam`: debe existir en la sala (`label` exacto) y tener
   * cupo, o se rechaza — nunca se reasigna en silencio a otro equipo. Sin
   * `requestedTeam`: asignacion automatica por el servidor, orden estable
   * `[A, B]` del propio agregado, primer equipo con cupo.
   */
  private static resolveTargetTeamIndex(
    teams: readonly [Team, Team],
    requestedTeam: string | null,
    roomId: string,
  ): 0 | 1 {
    if (requestedTeam !== null) {
      const index = teams.findIndex((team) => team.label === requestedTeam)

      if (index === -1) {
        throw new DomainError(`El equipo "${requestedTeam}" no existe en la sala "${roomId}".`)
      }

      // Indexacion con literal 0/1 (no con `index`, que TypeScript solo ve
      // como `number`): sobre una tupla `[Team, Team]` esto tipa `team` como
      // `Team`, nunca `Team | undefined`, sin recurrir a una asercion.
      const team = index === 0 ? teams[0] : teams[1]

      if (team.totalParticipants >= team.capacity) {
        throw new RoomFullError(roomId, requestedTeam)
      }

      return index === 0 ? 0 : 1
    }

    const autoIndex = teams.findIndex((team) => team.totalParticipants < team.capacity)

    if (autoIndex === -1) {
      // Defensa en profundidad: no alcanzable via join() en condiciones
      // normales, porque la sala solo permanece en WAITING_FOR_PLAYERS
      // mientras totalParticipants() < totalCapacity() (la propia mutacion
      // de join() pasa a PREPARING en el mismo instante en que se agota el
      // cupo total). Mismo criterio que InvalidRoomCapacityError en create().
      throw new RoomFullError(roomId, 'auto')
    }

    return autoIndex === 0 ? 0 : 1
  }
}

/**
 * Vencimiento candidato de una liquidacion de HU-21. La gracia lleva la
 * identidad del ausente; las otras dos causas no necesitan mas datos.
 */
type Expiry =
  | { readonly kind: 'grace'; readonly at: Date; readonly key: CombatantKey }
  | { readonly kind: 'global'; readonly at: Date }
  | { readonly kind: 'turn'; readonly at: Date }

/** Precedencia en un empate exacto (contrato §4.5): desconexion > tiempo > turno. */
const expiryPriority = (expiry: Expiry): number =>
  expiry.kind === 'grace' ? 0 : expiry.kind === 'global' ? 1 : 2

/** Estado final de un equipo, tal como lo publica el resultado (contrato §5). */
const standingOf = (life: TeamLife): TeamStanding => ({
  teamLabel: life.teamLabel,
  remainingHealth: life.remaining,
  maxHealth: life.max,
  lifePercent: lifePercentForDisplay(life.remaining, life.max),
  eliminated: life.allEliminated,
})

/** Resultado por participante, en el orden de la cola de turnos (contrato §5). */
const participantOutcomes = (
  turnOrder: readonly TurnOrderEntry[],
  outcome: BattleOutcome,
  winnerTeamLabel: string | null,
): readonly ParticipantOutcome[] =>
  turnOrder.map((entry) => ({
    teamLabel: entry.teamLabel,
    seat: entry.seat,
    kind: entry.kind,
    playerId: entry.playerId,
    displayName: entry.displayName,
    heroId: entry.heroId,
    result:
      outcome === 'NO_WINNER'
        ? ParticipantResults.NoWinner
        : entry.teamLabel === winnerTeamLabel
          ? ParticipantResults.Won
          : ParticipantResults.Lost,
  }))
