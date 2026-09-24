import { DomainError } from '../errors/DomainError'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  InvalidBattleRosterError,
  InsufficientPowerForHealError,
  InvalidCommandIdError,
  InvalidHealTargetError,
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
import { applyHeal, calculateHeal } from '../policies/HealApplicationPolicy'
import { spendPower } from '../policies/HeroPowerPolicy'
import {
  evaluateSkill,
  type SkillBonus,
  type TemporalEffectAudience,
  type TemporalEffectTemplate,
} from '../policies/SkillEffectPolicy'
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
import {
  StakeStatus,
  type ParticipantStake,
  type ParticipantStakeInput,
  type StakeAtRisk,
} from '../value-objects/ParticipantStake'
import { StakeNotAllowedInPveError } from '../errors/StakeErrors'
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
import type { ActiveSkillEffect, Combatant, CombatantKey } from './Combatant'
import type { CombatAbility, CombatMagnitude, CombatProfile } from './CombatProfile'
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

/**
 * HU-19 v2 (contrato §2): plantilla de un efecto temporal YA resuelta a un combatiente concreto
 * (audiencia -> `CombatantKey`), lista para que el caso de uso tire sus dados (si los hay,
 * `RandomSequencePort`) y `applySkill`/`applyHealingSkill` la adjunte DESPUES de `completeTurn`
 * (nunca antes: el cierre de turno propio de ESTA transaccion no debe alcanzar un efecto que
 * todavia no existia). `initialRemainingOwnTurns` es literalmente `durationTurns` (o `1` si la
 * habilidad no lo declaro): ver `resolveTemporalEffectTemplates`.
 */
export interface ResolvableTemporalEffect {
  readonly template: TemporalEffectTemplate
  readonly targetKey: CombatantKey
  readonly sourceAbilityId: string
  readonly sourceCombatant: CombatantKey
  readonly initialRemainingOwnTurns: number
}

/** Un efecto temporal ya resuelto (dados tirados) y el combatiente al que se adjunta. */
export interface ResolvedTemporalEffect {
  readonly targetKey: CombatantKey
  readonly effect: ActiveSkillEffect
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
  /**
   * Bonos de la habilidad al Ataque y al Dano, ya agregados por `evaluateSkill`. `damageBonus`
   * YA incluye el reflejo de dano (HU-19 v2, contrato §6) cuando la habilidad lo declara: se
   * calcula en `planSkill` (puro, sin sorteo) a partir de la memoria de dano del actor, y se
   * suma como un bono mas -- `UseSkill` no necesita saber que existe.
   */
  readonly attackBonus: SkillBonus
  readonly damageBonus: SkillBonus
  /** Poder del actor antes de pagar y el que le queda despues (`spendPower`). */
  readonly powerBefore: number
  readonly powerAfter: number
  /** HU-19 v2: efectos temporales que esta habilidad crea (Mano de piedra, Cono de hielo...). */
  readonly temporalEffects: readonly ResolvableTemporalEffect[]
}

/**
 * HU-19 v2 (contrato §3): un dano directo ya VALIDADO (`kind: DAMAGE`, Agonia), sin resolucion
 * de Ataque/Defensa -- listo para tirar su magnitud (si trae dados) y aplicarse.
 */
export interface SkillDirectDamageReadyPlan {
  readonly kind: 'directDamageSkill'
  readonly attackerEntry: TurnOrderEntry
  readonly targetEntry: TurnOrderEntry
  readonly attacker: Combatant
  readonly target: Combatant
  readonly targetHealth: number
  readonly ability: CombatAbility
  readonly damageBonus: SkillBonus
  readonly powerBefore: number
  readonly powerAfter: number
}

/** Un miembro elegible de un efecto de sanacion (HU-19 v2, contrato §1/§4): vivo, con perfil. */
export interface HealingRecipient {
  readonly entry: TurnOrderEntry
  readonly combatant: Combatant
}

/**
 * HU-19 v2 (contrato §1, familia `HEALING`): una sanacion ya VALIDADA, sobre un unico aliado
 * (`ALLY`) o sobre el grupo aliado del actor resuelto SERVER-SIDE (`ALLIED_GROUP`, contrato §4).
 * DETERMINISTA salvo la magnitud propia (si trae dados, se tira UNA vez y se aplica igual a
 * cada afectado -- mismo criterio que un reflejo o un bono: una sola tirada por accion).
 */
export interface SkillHealingReadyPlan {
  readonly kind: 'healingSkill'
  readonly attackerEntry: TurnOrderEntry
  readonly attacker: Combatant
  readonly attackerProfile: CombatProfile
  readonly recipients: readonly HealingRecipient[]
  readonly ability: CombatAbility
  readonly healBonus: SkillBonus
  readonly temporalEffects: readonly ResolvableTemporalEffect[]
  readonly powerBefore: number
  readonly powerAfter: number
}

/**
 * Una habilidad de curacion ya VALIDADA (excepcion de HU-12, Tabla 7: Reanimacion),
 * lista para resolverse: 0 sorteos hasta aqui NI DESPUES -- curar es determinista
 * (HealApplicationPolicy).
 */
export interface SkillHealReadyPlan {
  readonly kind: 'healSkill'
  readonly attackerEntry: TurnOrderEntry
  readonly targetEntry: TurnOrderEntry
  readonly attacker: Combatant
  readonly target: Combatant
  readonly attackerProfile: CombatProfile
  readonly targetProfile: CombatProfile
  readonly targetHealth: number
  readonly ability: CombatAbility
  /** Magnitud `PERCENTAGE` del efecto `REVIVE`, ya comprobada por `evaluateSkill`. */
  readonly healMagnitude: CombatMagnitude & { readonly mode: 'PERCENTAGE' }
  readonly powerBefore: number
  readonly powerAfter: number
}

/** El Poder no alcanza: la accion se degrada a un ataque basico contra el mismo objetivo (HU-11). */
export interface SkillDegradedPlan {
  readonly kind: 'degraded'
  readonly abilityId: string
}

export type SkillPlan =
  | SkillReadyPlan
  | SkillHealReadyPlan
  | SkillDirectDamageReadyPlan
  | SkillHealingReadyPlan
  | SkillDegradedPlan
  | BasicAttackReplay

/** Lo que HU-20, HU-25 y el sorteo de dano produjeron para una habilidad. */
export interface SkillOutcome extends BasicAttackOutcome {
  /** Bono de Ataque de la habilidad (fijo + dados), ya incluido en `attackValue`. */
  readonly attackBonus: number
  /** Bono de Dano (fijo + dados), ya incluido en `baseDamage`; `null` si no se tiro. */
  readonly damageBonus: number | null
  /** HU-19 v2: efectos temporales de esta habilidad, con sus dados ya resueltos. */
  readonly resolvedTemporalEffects: readonly ResolvedTemporalEffect[]
}

/** HU-19 v2 (contrato §3): resultado de un dano directo, sin resolucion de Ataque/Defensa. */
export interface DirectDamageOutcome {
  readonly calculatedDamage: number
}

/** HU-19 v2 (contrato §1, familia `HEALING`): resultado de una sanacion, igual para cada afectado. */
export interface HealingOutcome {
  readonly healAmount: number
  readonly resolvedTemporalEffects: readonly ResolvedTemporalEffect[]
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
 * HU-19 v2 (contrato §6): el bono de dano que aporta `REFLECT_DAMAGE` -- `floor(dano recibido x
 * basisPoints / 10000)` si la memoria de 1 turno propio sigue vigente; `0` si la habilidad no
 * declara el patron o si el actor no recibio dano en su turno propio anterior (no es un
 * rechazo: HU-19 v1 §4.2 ya establece que un efecto sin aporte no consume ni cambia nada).
 */
const reflectBonusFor = (
  reflect: { readonly basisPoints: number } | null,
  memory: { readonly amount: number; readonly remainingOwnTurns: number } | null,
): number => {
  if (reflect === null || memory === null || memory.remainingOwnTurns <= 0) {
    return 0
  }

  return Math.floor((memory.amount * reflect.basisPoints) / 10_000)
}

/** Los efectos temporales resueltos que le corresponden a `key` (HU-19 v2, contrato §2). */
const effectsFor = (
  resolved: readonly ResolvedTemporalEffect[],
  key: CombatantKey,
): readonly ActiveSkillEffect[] =>
  resolved.filter((item) => memberKey(item.targetKey) === memberKey(key)).map((item) => item.effect)

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

    // HU-23 (D4): una sala PVE no admite apuesta -- un participante AI no
    // tiene cuenta en Wallet. Se rechaza ANTES de que la aplicacion pueda
    // llamar a Wallet (el caso de uso construye el agregado antes de reservar).
    if (
      mode === BattleMode.Pve &&
      [...teamA.participants, ...teamB.participants].some(
        (participant) => participant.stake !== undefined,
      )
    ) {
      throw new StakeNotAllowedInPveError()
    }

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
    stake: ParticipantStakeInput | null = null,
  ): BattleRoom {
    if (this.status !== BattleRoomStatus.WaitingForPlayers) {
      throw new RoomNotJoinableError(this.id, this.status)
    }

    // HU-23 (D4): `0` = no apostar; cualquier monto > 0 en PVE se rechaza
    // antes de que la aplicacion llame a Wallet.
    const stakeInput = stake !== null && stake.amount !== 0 ? stake : null

    if (this.mode === BattleMode.Pve && stakeInput !== null) {
      throw new StakeNotAllowedInPveError()
    }

    const participant = createParticipant(
      {
        kind: ParticipantKind.Human,
        playerId,
        heroId,
        heroLoadoutVersion,
        displayName,
        ...(stakeInput === null ? {} : { stake: stakeInput }),
      },
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
   * Apuestas de la sala con la posicion de cada participante (HU-23), en el
   * orden de los equipos. Base de `BattleStakePolicy` y de los servicios de
   * reserva/liberacion/liquidacion.
   */
  stakesAtRisk(): readonly StakeAtRisk[] {
    const stakes: StakeAtRisk[] = []

    for (const team of this.teams) {
      team.participants.forEach((participant, seat) => {
        if (participant.stake === undefined || participant.playerId === null) {
          return
        }

        stakes.push({
          teamLabel: team.label,
          seat,
          playerId: participant.playerId,
          amount: participant.stake.amount,
          holdOperationId: participant.stake.holdOperationId,
          status: participant.stake.status,
        })
      })
    }

    return stakes
  }

  /** La apuesta de un jugador, o `null` si no aposto o no es participante. */
  stakeOf(playerId: string): ParticipantStake | null {
    for (const team of this.teams) {
      for (const participant of team.participants) {
        if (participant.kind === ParticipantKind.Human && participant.playerId === playerId) {
          return participant.stake ?? null
        }
      }
    }

    return null
  }

  /**
   * Pasa TODAS las apuestas `PENDING_RESERVE` a `ACTIVE`. Lo invoca la
   * aplicacion DESPUES de que Wallet confirmo cada reserva (D8: la reserva es
   * sincrona) y ANTES de persistir: una sala guardada nunca tiene una apuesta
   * `PENDING_RESERVE`.
   */
  withStakesActivated(): BattleRoom {
    return this.withStakeStatuses(
      this.stakesAtRisk()
        .filter((stake) => stake.status === StakeStatus.PendingReserve)
        .map((stake) => ({ holdOperationId: stake.holdOperationId, status: StakeStatus.Active })),
    )
  }

  /**
   * Devuelve una sala nueva con el estado de las apuestas indicadas
   * actualizado, en la MISMA escritura que el resto del agregado. Un
   * `holdOperationId` que no corresponda a ninguna apuesta de la sala es una
   * inconsistencia (no un no-op silencioso): el llamador solo actualiza holds
   * que acaba de confirmar contra Wallet.
   */
  withStakeStatuses(
    updates: readonly { readonly holdOperationId: string; readonly status: StakeStatus }[],
  ): BattleRoom {
    if (updates.length === 0) {
      return this
    }

    const byHold = new Map(updates.map((update) => [update.holdOperationId, update.status]))
    const applied = new Set<string>()

    const updateTeam = (team: Team): Team =>
      team.withParticipants(
        team.participants.map((participant) => {
          if (participant.stake === undefined) {
            return participant
          }

          const status = byHold.get(participant.stake.holdOperationId)

          if (status === undefined) {
            return participant
          }

          applied.add(participant.stake.holdOperationId)

          return { ...participant, stake: { ...participant.stake, status } }
        }),
      )

    const teams: readonly [Team, Team] = [updateTeam(this.teams[0]), updateTeam(this.teams[1])]

    if (applied.size !== byHold.size) {
      throw new DomainError(
        'Se intento actualizar una apuesta que no pertenece a esta sala (hold desconocido).',
      )
    }

    return new BattleRoom(
      this.id,
      this.mode,
      this.status,
      teams,
      this.reward,
      this.createdBy,
      this.createdAt,
      this._version,
      {
        battle: this.battle,
        events: this.events,
        handledCommands: this.handledCommands,
        result: this.result,
      },
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
   * La mitad del contexto que NO depende del objetivo (HU-18/HU-19): batalla en
   * curso, turno del solicitante, snapshot de combate, perfil y Vida del actor.
   * Separada de la resolucion del objetivo (`requireTargetCombatant`) porque
   * `planSkill` necesita conocer la HABILIDAD (que sale de `attacker.abilities`)
   * ANTES de decidir si el objetivo debe ser un rival o un aliado -- la excepcion
   * de curacion de HU-12 no se puede resolver sin esa informacion, y antes de
   * ella no hacia falta (todo objetivo era siempre un rival).
   */
  private requireAttackerTurn(actorPlayerId: string): {
    readonly attackerEntry: TurnOrderEntry
    readonly attacker: Combatant
    readonly attackerProfile: CombatProfile
  } {
    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    const attackerEntry = this.battle.currentEntry

    if (attackerEntry.kind !== ParticipantKind.Human || attackerEntry.playerId !== actorPlayerId) {
      throw new NotYourTurnError(this.id)
    }

    if (this.battle.combatants === null) {
      throw new UnsupportedCombatProfileError(
        'la batalla comenzo antes de habilitar el ataque basico y no tiene snapshot de combate.',
      )
    }

    const attacker = this.battle.combatantFor(attackerEntry)

    if (attacker === undefined) {
      throw new DomainError('El snapshot de combate no contiene al atacante.')
    }

    if (attacker.profile === null || attacker.currentHealth === null) {
      throw new UnsupportedCombatProfileError('el atacante no tiene perfil de combate.')
    }

    if (!attacker.alive) {
      throw new ActorUnavailableError()
    }

    return { attackerEntry, attacker, attackerProfile: attacker.profile }
  }

  /**
   * Resuelve y valida el objetivo (HU-18/HU-19, mas la excepcion de curacion de
   * HU-12): existe en la batalla, tiene la audiencia correcta -- `OPPONENT`
   * (rival, el default de siempre: RF-12 bloquea el propio equipo, incluido uno
   * mismo) o `ALLY` (companero DISTINTO del actor, solo para la habilidad de
   * curacion soportada) -- y tiene perfil.
   *
   * LA VIDA DEL OBJETIVO SOLO SE EXIGE PARA `OPPONENT`: no se ataca a alguien ya
   * caido (`TargetUnavailableError`, sin cambios). Para `ALLY` NO se exige ni
   * vivo ni caido -- Reanimacion (`kind: 'REVIVE'`) es "sana el 100% de la vida
   * del companero" sin mas condicion en la Tabla 7, y su nombre (reanimar) sugiere
   * que el uso real es levantar a un companero caido (Vida 0): un companero caido
   * SIGUE en `turnOrder`/`combatants` mientras su equipo no este eliminado
   * (`BattleState.hasLifeAt` solo le salta el turno, no lo retira), asi que es un
   * objetivo perfectamente valido. Exigirlo vivo excluiria el caso central de la
   * habilidad; exigirlo caido excluiria curar a un companero herido pero vivo, que
   * el texto tampoco prohibe. Ninguna de las dos restricciones esta en el
   * documento oficial: no se inventan.
   */
  private requireTargetCombatant(
    attackerEntry: TurnOrderEntry,
    target: CombatantKey,
    audience: 'OPPONENT' | 'ALLY',
  ): {
    readonly targetEntry: TurnOrderEntry
    readonly target: Combatant
    readonly targetProfile: CombatProfile
    readonly targetHealth: number
  } {
    // Se llama tras `requireAttackerTurn`, que ya comprueba esto -- se repite aqui
    // (mismo criterio que el resto del agregado) para que TypeScript estreche el
    // tipo sin una asercion, no porque pueda cambiar entre ambas llamadas.
    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    const battle = this.battle

    const targetEntry = battle.turnOrder.find(
      (entry) => entry.teamLabel === target.teamLabel && entry.seat === target.seat,
    )

    if (targetEntry === undefined) {
      throw new InvalidTargetError(this.id)
    }

    const sameTeam = targetEntry.teamLabel === attackerEntry.teamLabel
    const isSelf = sameTeam && targetEntry.seat === attackerEntry.seat

    if (audience === 'OPPONENT' && sameTeam) {
      throw new SameTeamTargetError()
    }

    if (audience === 'ALLY' && (!sameTeam || isSelf)) {
      throw new InvalidHealTargetError()
    }

    const targetCombatant = battle.combatantFor(targetEntry)

    if (targetCombatant === undefined) {
      throw new DomainError('El snapshot de combate no contiene al objetivo.')
    }

    if (targetCombatant.profile === null || targetCombatant.currentHealth === null) {
      throw new UnsupportedCombatProfileError('el objetivo no tiene perfil de combate.')
    }

    if (audience === 'OPPONENT' && !targetCombatant.alive) {
      throw new TargetUnavailableError()
    }

    return {
      targetEntry,
      target: targetCombatant,
      targetProfile: targetCombatant.profile,
      targetHealth: targetCombatant.currentHealth,
    }
  }

  /**
   * Lo que comparten el ataque basico y las habilidades OFENSIVAS (HU-18/HU-19):
   * el objetivo es SIEMPRE un rival (`requireTargetCombatant(..., 'OPPONENT')`).
   * `planSkill` no la usa mas: resuelve el actor y el objetivo por separado para
   * poder variar la audiencia segun la habilidad (excepcion de curacion, HU-12).
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
    const attackerContext = this.requireAttackerTurn(actorPlayerId)
    const targetContext = this.requireTargetCombatant(
      attackerContext.attackerEntry,
      target,
      'OPPONENT',
    )

    return { ...attackerContext, ...targetContext }
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
    // HU-19 v2 (contrato §6): un ataque basico tambien alimenta la memoria de dano de
    // `REFLECT_DAMAGE` -- es generica, de cualquier fuente de dano, no solo de habilidades.
    const battle = this.battle
      .withCombatant(
        plan.target.withHealth(applied.healthAfter).withDamageTaken(applied.appliedDamage),
      )
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
   * Valida una habilidad especial (HU-19, contrato `hu-19-skills-v1`, §3; excepcion de
   * curacion HU-12/Tabla 7) ANTES de consumir un solo sorteo. Orden: `commandId` (forma),
   * repeticion, batalla, turno del actor (los mismos de `attack`, SIN el objetivo todavia),
   * estado de habilidades, habilidad del heroe (CA-02), efectos soportados -- que decide
   * si el objetivo debe ser un rival o un aliado --, objetivo con la audiencia correcta,
   * recarga (CA-04, CA-07) y, al final, el Poder (CA-03).
   *
   * EL OBJETIVO SE RESUELVE DESPUES DE LA HABILIDAD (a diferencia de `attack`, que no
   * tiene mas que una audiencia posible): la excepcion de curacion de HU-12 no se puede
   * decidir sin saber si `abilityId` es la habilidad de curacion soportada. Con una
   * habilidad ofensiva el orden efectivo es identico al de antes (el rechazo por equipo
   * sigue ocurriendo, solo que un paso mas tarde).
   *
   * Poder insuficiente en una habilidad OFENSIVA NO es un error: HU-11 exige forzar el
   * ataque basico en ese turno, asi que se devuelve `degraded` y el llamador ejecuta un
   * ataque basico contra el mismo objetivo, con el Poder y la recarga intactos. Un
   * sanador NO puede degradar (no tiene Ataque numerico, Tabla 6): Poder insuficiente en
   * la habilidad de curacion es un rechazo directo (`InsufficientPowerForHealError`).
   * Una habilidad que el sistema no sabe ejecutar se rechaza ANTES de hablar de Poder: no
   * se fuerza un ataque por ella.
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

    const { attackerEntry, attacker, attackerProfile } = this.requireAttackerTurn(actorPlayerId)
    const maxPower = attackerProfile.maxPower

    if (maxPower === undefined || attacker.currentPower === null || !attacker.hasSkillState) {
      throw new SkillsNotAvailableError()
    }

    const currentPower = attacker.currentPower
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

    // HU-19 v2: `HEAL` (Reanimacion, v1 sin cambios) y `HEALING` (contrato §1) son sanadores --
    // no tienen Ataque numerico y NO degradan con Poder insuficiente (excepcion de HU-12).
    if (support.kind === 'HEAL') {
      const targetContext = this.requireTargetCombatant(attackerEntry, target, 'ALLY')
      const payment = spendPower(
        { heroId: memberKey(attackerEntry), current: currentPower, max: maxPower },
        ability.powerCost,
      )

      if (!payment.ok) {
        throw new InsufficientPowerForHealError()
      }

      return {
        kind: 'healSkill',
        attackerEntry,
        attacker,
        attackerProfile,
        ...targetContext,
        ability,
        healMagnitude: support.healMagnitude,
        powerBefore: currentPower,
        powerAfter: payment.state.current,
      }
    }

    if (support.kind === 'HEALING') {
      const recipients = this.resolveHealingRecipients(attackerEntry, target, support.audience)
      const payment = spendPower(
        { heroId: memberKey(attackerEntry), current: currentPower, max: maxPower },
        ability.powerCost,
      )

      if (!payment.ok) {
        throw new InsufficientPowerForHealError()
      }

      // Un efecto temporal de sanacion (Vinculo Natural, Canto del Bosque) se adjunta a CADA
      // afectado individualmente -- no solo al primero: cada uno lleva su PROPIA cuenta de
      // "turnos propios" (contrato §2, la convencion es del combatiente objetivo).
      const temporalEffects = recipients.flatMap((recipient) =>
        BattleRoom.resolveTemporalEffectTemplates(
          support.temporalEffects,
          () => recipient.entry,
          ability.abilityId,
          attackerEntry,
        ),
      )

      return {
        kind: 'healingSkill',
        attackerEntry,
        attacker,
        attackerProfile,
        recipients,
        ability,
        healBonus: support.healBonus,
        temporalEffects,
        powerBefore: currentPower,
        powerAfter: payment.state.current,
      }
    }

    // A partir de aqui la habilidad es OFENSIVA (`DAMAGE` o `DIRECT_DAMAGE`): objetivo rival,
    // y el Poder insuficiente DEGRADA a ataque basico (HU-11) en vez de rechazar.
    if (attackerProfile.attack === null) {
      throw new UnsupportedCombatProfileError('el heroe no tiene un valor de Ataque numerico.')
    }

    const targetContext = this.requireTargetCombatant(attackerEntry, target, 'OPPONENT')

    const payment = spendPower(
      { heroId: memberKey(attackerEntry), current: currentPower, max: maxPower },
      ability.powerCost,
    )

    if (!payment.ok) {
      return { kind: 'degraded', abilityId }
    }

    if (support.kind === 'DIRECT_DAMAGE') {
      return {
        kind: 'directDamageSkill',
        attackerEntry,
        attacker,
        ...targetContext,
        ability,
        damageBonus: support.damageBonus,
        powerBefore: currentPower,
        powerAfter: payment.state.current,
      }
    }

    // support.kind === 'DAMAGE': el patron "ataque mejorado" de v1, ampliado con el reflejo de
    // dano (contrato §6, puro: se calcula aqui de la memoria YA persistida, sin sorteo) y los
    // efectos temporales que esta habilidad crea (contrato §2).
    const reflectBonus = reflectBonusFor(support.reflect, attacker.damageMemory)
    const audienceKey = (audience: TemporalEffectAudience): CombatantKey => {
      if (audience === 'SELF') {
        return attackerEntry
      }

      if (audience === 'OPPONENT') {
        return targetContext.targetEntry
      }

      throw new DomainError(`Un efecto ofensivo no puede tener audiencia ${audience}.`)
    }

    return {
      kind: 'skill',
      attackerEntry,
      attacker,
      attackerProfile,
      ...targetContext,
      damage: assertSupportedDamage(attackerProfile.damage),
      ability,
      attackBonus: support.attackBonus,
      damageBonus: {
        fixed: support.damageBonus.fixed + reflectBonus,
        dice: support.damageBonus.dice,
      },
      powerBefore: currentPower,
      powerAfter: payment.state.current,
      temporalEffects: BattleRoom.resolveTemporalEffectTemplates(
        support.temporalEffects,
        audienceKey,
        ability.abilityId,
        attackerEntry,
      ),
    }
  }

  /**
   * HU-19 v2 (contrato §4): resuelve a QUIEN afecta una sanacion. `ALLY` reutiliza
   * `requireTargetCombatant` (sin reescribirla): un unico companero distinto del actor. Para
   * `ALLIED_GROUP` (Canto del Bosque) el `target` del comando NO es la fuente del alcance --
   * Combat solo comprueba que exista en la batalla (forma del mensaje) y calcula el grupo
   * SERVER-SIDE, del equipo del actor, vivos y con perfil de combate (el actor incluido si
   * cumple ambos).
   */
  private resolveHealingRecipients(
    attackerEntry: TurnOrderEntry,
    target: CombatantKey,
    audience: 'ALLY' | 'ALLIED_GROUP',
  ): readonly HealingRecipient[] {
    if (audience === 'ALLY') {
      const targetContext = this.requireTargetCombatant(attackerEntry, target, 'ALLY')

      return [{ entry: targetContext.targetEntry, combatant: targetContext.target }]
    }

    if (this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    const battle = this.battle
    const targetExists = battle.turnOrder.some(
      (entry) => entry.teamLabel === target.teamLabel && entry.seat === target.seat,
    )

    if (!targetExists) {
      throw new InvalidTargetError(this.id)
    }

    const recipients = battle.turnOrder
      .filter((entry) => entry.teamLabel === attackerEntry.teamLabel)
      .flatMap((entry): readonly HealingRecipient[] => {
        const combatant = battle.combatantFor(entry)
        const eligible =
          combatant?.profile !== null && combatant?.profile !== undefined && combatant.alive

        return eligible ? [{ entry, combatant }] : []
      })

    // Inalcanzable en la practica: el propio actor esta vivo y con perfil (ya comprobado por
    // `requireAttackerTurn`), asi que siempre aparece en su propio equipo.
    if (recipients.length === 0) {
      throw new DomainError(
        'Ningun miembro elegible del equipo del actor para la sanacion de grupo.',
      )
    }

    return recipients
  }

  /**
   * HU-19 v2 (contrato §2): resuelve cada plantilla de efecto temporal a un combatiente
   * concreto (`audienceKey`). `initialRemainingOwnTurns` es literalmente `durationTurns` (o `1`
   * si no se declaro): el efecto se ADJUNTA DESPUES de `completeTurn` (ver `applySkill` /
   * `applyHealingSkill`), nunca antes -- as; el cierre del turno propio de ESTA MISMA
   * transaccion no lo alcanza (ni lo decrementa ni, si es de Sanacion, lo tira UNA vez de mas):
   * "no se aplica a esta resolucion", el mismo principio que ya vale para el bono instantaneo de
   * Ataque/Dano (v1 §4), ahora aplicado tambien al primer tick/decremento de un efecto nuevo.
   */
  private static resolveTemporalEffectTemplates(
    templates: readonly TemporalEffectTemplate[],
    audienceKey: (audience: TemporalEffectAudience) => CombatantKey,
    sourceAbilityId: string,
    sourceCombatant: CombatantKey,
  ): readonly ResolvableTemporalEffect[] {
    return templates.map((template) => ({
      template,
      targetKey: audienceKey(template.family === 'IMMUNITY' ? 'SELF' : template.audience),
      sourceAbilityId,
      sourceCombatant,
      initialRemainingOwnTurns: template.durationTurns ?? 1,
    }))
  }

  /**
   * Adjunta los efectos temporales YA resueltos a cada combatiente de `keys` que tenga alguno
   * (contrato §2), SOBRE el `battle` que el llamador ya avanzo con `completeTurn` -- nunca
   * antes: ver `resolveTemporalEffectTemplates`. Sin efectos para ninguna `key`, devuelve el
   * mismo `battle` (no crea version nueva si no hace falta).
   */
  private static withActiveEffectsAttached(
    battle: BattleState,
    resolved: readonly ResolvedTemporalEffect[],
    keys: readonly CombatantKey[],
  ): BattleState {
    if (resolved.length === 0) {
      return battle
    }

    let next = battle

    for (const key of keys) {
      const effects = effectsFor(resolved, key)

      if (effects.length === 0) {
        continue
      }

      const combatant = next.combatantFor(key)

      if (combatant === undefined) {
        throw new DomainError('Un efecto temporal se adjunta a un combatiente que no participa.')
      }

      next = next.withCombatant(combatant.withAddedActiveSkillEffects(effects))
    }

    return next
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
    // HU-19 v2 (contrato §6): el objetivo recuerda el dano recibido (memoria de 1 turno propio
    // para `REFLECT_DAMAGE`), igual que ya hace un ataque basico.
    const targetCombatant = plan.target
      .withHealth(applied.healthAfter)
      .withDamageTaken(applied.appliedDamage)
    const turnClosed = this.battle
      .withCombatant(actor)
      .withCombatant(targetCombatant)
      .completeTurn(at)
    // Los efectos temporales NUEVOS de esta habilidad se adjuntan DESPUES de `completeTurn`
    // (contrato §2): asi el cierre del turno propio de ESTA MISMA transaccion no los alcanza --
    // ni los decrementa ni, si son de Sanacion, los tira una vez de mas antes de haber existido
    // un solo turno completo. Solo entonces empiezan a valer para resoluciones FUTURAS.
    const battle = BattleRoom.withActiveEffectsAttached(
      turnClosed,
      outcome.resolvedTemporalEffects,
      [plan.attackerEntry, plan.targetEntry],
    )
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
   * Aplica una habilidad de curacion ya resuelta (excepcion de HU-12, Tabla 7:
   * Reanimacion) como UNA sola transicion del agregado, mismo criterio que
   * `applySkill`: Vida del ALIADO objetivo + Poder del actor + recarga + evento +
   * `commandId` procesado + turno avanzado, en una unica version nueva.
   *
   * DETERMINISTA: a diferencia de `applySkill`, no hay `outcome` que resolver --
   * curar no consume la secuencia HU-24 (`HealApplicationPolicy`, sin sorteo). El
   * monto se calcula aqui mismo, contra el maximo de Vida del OBJETIVO (nunca del
   * actor): `floor(maxHealth(objetivo) x basisPoints / 10000)`.
   */
  applyHealSkill(plan: SkillHealReadyPlan, commandId: string, at: Date): BattleRoom {
    BattleRoom.assertValidCommandId(commandId)

    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    const calculatedHeal = calculateHeal(
      plan.targetProfile.maxHealth,
      plan.healMagnitude.basisPoints,
    )
    const applied = applyHeal(plan.targetHealth, plan.targetProfile.maxHealth, calculatedHeal)
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
      type: BattleEventType.HealSkillUsed,
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
        heal: { amount: applied.appliedHeal },
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

    // Curar nunca reduce la Vida de nadie: no puede eliminar a un equipo. Se
    // conserva la llamada por simetria estructural con `applySkill`/
    // `applyBasicAttack` (defensa en profundidad, no alcanzable hoy).
    return next.concludeIfEliminated(plan.attackerEntry.teamLabel, at)
  }

  /**
   * Aplica un dano directo ya resuelto (HU-19 v2, contrato §3: `kind: DAMAGE`, Agonia) como UNA
   * sola transicion del agregado, mismo criterio que `applySkill`: Vida del objetivo + Poder del
   * actor + recarga + memoria de dano (§6) + evento + `commandId` procesado + turno avanzado.
   * SIN resolucion de Ataque/Defensa: el dano se materializa tal cual, sin `calculateDamage`
   * (no hay porcentaje que aplicarle).
   */
  applyDirectDamageSkill(
    plan: SkillDirectDamageReadyPlan,
    outcome: DirectDamageOutcome,
    commandId: string,
    at: Date,
  ): BattleRoom {
    BattleRoom.assertValidCommandId(commandId)

    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    const applied = applyDamage(plan.targetHealth, outcome.calculatedDamage)
    const completedPosition = this.battle.currentPosition
    const actor = plan.attacker
      .withPower(plan.powerAfter)
      .withCooldown(plan.ability.abilityId, plan.ability.chargeTurns + 1)
    const targetCombatant = plan.target
      .withHealth(applied.healthAfter)
      .withDamageTaken(applied.appliedDamage)
    const battle = this.battle.withCombatant(actor).withCombatant(targetCombatant).completeTurn(at)
    const seq = this.lastSeq + 1
    const event: BattleEvent = {
      seq,
      type: BattleEventType.DirectDamageSkillUsed,
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
        damage: {
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

    return next.concludeIfEliminated(plan.attackerEntry.teamLabel, at)
  }

  /**
   * Aplica una sanacion de la familia `HEALING` (HU-19 v2, contrato §1: Toque de la Vida,
   * Vinculo Natural, Canto del Bosque, Curacion Directa, Neutralizacion de Efectos) como UNA
   * sola transicion del agregado: Vida de CADA afectado + Poder del actor + recarga + efectos
   * temporales (§2) + evento (con `affected` cuando es de grupo, §4) + `commandId` procesado +
   * turno avanzado. El mismo `healAmount` (ya resuelto, con su dado si lo hubo) se aplica a
   * cada afectado, acotado a SU propio maximo (sin overheal) -- ninguno de los dos comparte
   * Vida con otro.
   */
  applyHealingSkill(
    plan: SkillHealingReadyPlan,
    outcome: HealingOutcome,
    commandId: string,
    at: Date,
  ): BattleRoom {
    BattleRoom.assertValidCommandId(commandId)

    if (this.status !== BattleRoomStatus.InBattle || this.battle === null) {
      throw new BattleNotInProgressError(this.id, this.status)
    }

    const completedPosition = this.battle.currentPosition
    const actor = plan.attacker
      .withPower(plan.powerAfter)
      .withCooldown(plan.ability.abilityId, plan.ability.chargeTurns + 1)

    let battle = this.battle.withCombatant(actor)
    const healed: {
      readonly key: CombatantKey
      readonly before: number
      readonly after: number
    }[] = []

    for (const recipient of plan.recipients) {
      const maxHealth = recipient.combatant.profile?.maxHealth ?? 0
      const currentHealth = recipient.combatant.currentHealth ?? 0
      const applied = applyHeal(currentHealth, maxHealth, outcome.healAmount)

      battle = battle.withCombatant(recipient.combatant.withHealth(applied.healthAfter))
      healed.push({
        key: recipient.entry,
        before: applied.healthBefore,
        after: applied.healthAfter,
      })
    }

    battle = battle.completeTurn(at)
    // Los efectos temporales NUEVOS (Vinculo Natural, Canto del Bosque) se adjuntan DESPUES de
    // `completeTurn` (contrato §2, mismo criterio que `applySkill`): ninguno tira su PRIMER tick
    // de sanacion en esta misma transaccion, ni siquiera para el propio actor cuando se incluye
    // en su propio grupo aliado.
    battle = BattleRoom.withActiveEffectsAttached(
      battle,
      outcome.resolvedTemporalEffects,
      plan.recipients.map((recipient) => recipient.entry),
    )

    // Siempre hay al menos un afectado (`resolveHealingRecipients` nunca devuelve `[]`).
    const primary = healed[0] as {
      readonly key: CombatantKey
      readonly before: number
      readonly after: number
    }
    const seq = this.lastSeq + 1
    const event: BattleEvent = {
      seq,
      type: BattleEventType.HealSkillUsed,
      occurredAt: at,
      payload: {
        commandId,
        completedPosition,
        actor: { teamLabel: plan.attackerEntry.teamLabel, seat: plan.attackerEntry.seat },
        target: { teamLabel: primary.key.teamLabel, seat: primary.key.seat },
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
        heal: { amount: outcome.healAmount },
        targetHealth: { before: primary.before, after: primary.after },
        // HU-19 v2 (contrato §4): solo presente cuando afecto a mas de un combatiente.
        ...(healed.length > 1
          ? {
              affected: healed.map((entry) => ({
                teamLabel: entry.key.teamLabel,
                seat: entry.key.seat,
              })),
            }
          : {}),
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

    // Curar nunca reduce la Vida de nadie: no puede eliminar a un equipo (mismo criterio que
    // `applyHealSkill`).
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
