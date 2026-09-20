import { DomainError } from '../errors/DomainError'
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
  createParticipant,
  ParticipantKind,
  type Participant,
  type ParticipantInput,
} from './Participant'
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
    if (this.status === BattleRoomStatus.Cancelled) {
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
