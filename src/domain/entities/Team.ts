import { DomainError } from '../errors/DomainError'
import { InvalidModeCompositionError, InvalidTeamCapacityError } from '../errors/BattleRoomErrors'
import { createParticipant, type Participant, type ParticipantInput } from './Participant'

export interface TeamSnapshot {
  readonly label: string
  readonly capacity: number
  readonly participants: readonly ParticipantInput[]
}

/**
 * Equipo dentro de una sala de batalla (RF-14: "numero de jugadores por
 * equipo, maximo 3").
 *
 * DISTINGUE CAPACIDAD CONFIGURADA DE OCUPACION ACTUAL (HU-14.1,
 * `HU-14.1-Decisiones-Tecnicas.md`, punto 3): `capacity` se fija al crear la
 * sala y no cambia; `participants` es progresivo y puede empezar vacio — el
 * llenado hasta `capacity` es responsabilidad de HU-15.
 */
export class Team {
  readonly label: string
  readonly capacity: number
  readonly participants: readonly Participant[]

  private constructor(label: string, capacity: number, participants: readonly Participant[]) {
    this.label = label
    this.capacity = capacity
    this.participants = participants
  }

  /**
   * Crea un equipo nuevo validando las reglas de negocio de HU-14: capacidad
   * en 1..3 (`InvalidTeamCapacityError`) y que los participantes declarados
   * no superen esa capacidad (`InvalidModeCompositionError`). La coherencia
   * humano/IA frente a `mode` se valida en `BattleRoom.create()`, que conoce
   * ambos equipos a la vez.
   */
  static create(
    label: string,
    capacity: number,
    initialParticipants: readonly ParticipantInput[],
    at: Date,
  ): Team {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 3) {
      throw new InvalidTeamCapacityError(label, capacity)
    }

    const participants = initialParticipants.map((input) => createParticipant(input, at))

    if (participants.length > capacity) {
      throw new InvalidModeCompositionError(
        `El equipo ${label} declara ${String(participants.length)} participante(s), mas que su capacidad (${String(capacity)}).`,
      )
    }

    return new Team(label, capacity, participants)
  }

  /**
   * Reconstruye un equipo desde persistencia. Solo comprobaciones
   * estructurales (`DomainError`): los datos ya pasaron las reglas de
   * negocio al escribirse, y tratar una inconsistencia de almacenamiento
   * como una regla de negocio incumplida confundiria dos causas distintas.
   */
  static restore(snapshot: TeamSnapshot): Team {
    if (snapshot.label.trim().length === 0) {
      throw new DomainError('Un equipo restaurado necesita una etiqueta.')
    }
    if (!Number.isInteger(snapshot.capacity) || snapshot.capacity < 1 || snapshot.capacity > 3) {
      throw new DomainError(`La capacidad restaurada del equipo "${snapshot.label}" no es valida.`)
    }

    const participants = snapshot.participants.map((input) =>
      createParticipant(input, input.joinedAt ?? new Date(0)),
    )

    if (participants.length > snapshot.capacity) {
      throw new DomainError(
        `El equipo restaurado "${snapshot.label}" tiene mas participantes que capacidad.`,
      )
    }

    return new Team(snapshot.label, snapshot.capacity, participants)
  }

  get totalParticipants(): number {
    return this.participants.length
  }

  /**
   * Devuelve un equipo nuevo con un participante mas (HU-15.2, `join()`).
   *
   * NO valida cupo aqui: a diferencia de `create()` (que es la unica entrada
   * publica y por tanto debe autoprotegerse), este metodo solo lo invoca
   * `BattleRoom.join()`, que YA decidio el equipo objetivo comprobando su
   * cupo antes de llamar — mismo criterio de reparto de responsabilidades
   * que `validateModeComposition` (BattleRoom conoce ambos equipos a la vez,
   * Team no). Repetir la validacion aqui duplicaria la regla, no la
   * reforzaria.
   */
  withParticipant(participant: Participant): Team {
    return new Team(this.label, this.capacity, [...this.participants, participant])
  }

  /**
   * Devuelve un equipo nuevo sin el participante `HUMAN` con ese `playerId`
   * (HU-15.2, `leave()`). Si nadie coincide, devuelve un equipo equivalente
   * sin cambios -- `BattleRoom.leave()` ya verifico antes de llamar que el
   * jugador esta presente en ALGUN equipo de la sala, mismo reparto de
   * responsabilidades que `withParticipant()`.
   */
  withoutParticipant(playerId: string): Team {
    return new Team(
      this.label,
      this.capacity,
      this.participants.filter((participant) => participant.playerId !== playerId),
    )
  }

  toSnapshot(): TeamSnapshot {
    return {
      label: this.label,
      capacity: this.capacity,
      participants: this.participants.map((participant) => ({ ...participant })),
    }
  }
}
