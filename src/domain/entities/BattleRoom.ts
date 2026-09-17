import { DomainError } from '../errors/DomainError'
import {
  InvalidModeCompositionError,
  InvalidRoomCapacityError,
  InvalidTeamCapacityError,
  RoomCancellationForbiddenError,
  RoomNotCancellableError,
} from '../errors/BattleRoomErrors'
import { BattleRoomId } from '../value-objects/BattleRoomId'
import { BattleMode, parseBattleMode } from '../value-objects/BattleMode'
import { BattleRoomStatus, parseBattleRoomStatus } from '../value-objects/BattleRoomStatus'
import { RewardConfig, type RewardConfigSnapshot } from '../value-objects/RewardConfig'
import { ParticipantKind, type Participant, type ParticipantInput } from './Participant'
import { Team, type TeamSnapshot } from './Team'

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
}

/**
 * Sala de batalla (HU-14, RF-14). Aggregate root: cupo, equipos, modalidad,
 * recompensa y estado cambian juntos en una sola escritura (HU-14.1,
 * `HU-14.1-Decisiones-Tecnicas.md`, punto 1). No se modela `Battle`: HU-14
 * solo crea salas, no inicia batallas (HU-17+).
 */
export class BattleRoom {
  readonly id: string
  readonly mode: BattleMode
  readonly status: BattleRoomStatus
  readonly teams: readonly [Team, Team]
  readonly reward: RewardConfig
  readonly createdBy: string
  readonly createdAt: Date
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
  ) {
    this.id = id
    this.mode = mode
    this.status = status
    this.teams = teams
    this.reward = reward
    this.createdBy = createdBy
    this.createdAt = createdAt
    this._version = version
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
  static restore(snapshot: BattleRoomSnapshot): BattleRoom {
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

    return new BattleRoom(
      roomId.value,
      mode,
      status,
      teams,
      reward,
      snapshot.createdBy.trim(),
      snapshot.createdAt,
      snapshot.version,
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
   */
  private static validateUniqueHumanPlayers(participants: readonly Participant[]): void {
    const seenPlayerIds = new Set<string>()

    for (const participant of participants) {
      if (participant.kind !== ParticipantKind.Human || participant.playerId === null) {
        continue
      }

      if (seenPlayerIds.has(participant.playerId)) {
        throw new InvalidModeCompositionError(
          `El jugador "${participant.playerId}" no puede ocupar mas de un puesto HUMAN en la misma sala.`,
        )
      }

      seenPlayerIds.add(participant.playerId)
    }
  }
}
