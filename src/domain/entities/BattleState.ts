import { DomainError } from '../errors/DomainError'
import { InvalidBattleRosterError } from '../errors/BattleErrors'
import { ParticipantKind } from './Participant'
import { memberKey, type TurnOrderEntry } from './TurnOrder'

export interface BattleStateSnapshot {
  readonly startedAt: Date
  readonly turnOrder: readonly TurnOrderEntry[]
  readonly turnsCompleted: number
}

/** Entrada de la cola tal como la ve un cliente: la entrada mas su posicion. */
export interface TurnOrderEntryView extends TurnOrderEntry {
  readonly position: number
}

/**
 * Vista de la batalla visible para los participantes (HU-17). Solo tipos JSON
 * (fechas ISO), para que el evento persistido sea IDENTICO al que reciben
 * todos los clientes. No contiene semilla, estado del generador, numero de
 * sorteos ni ningun dato interno.
 */
export interface BattleView {
  /** Igual al `roomId`: una sala produce como maximo una batalla. */
  readonly battleId: string
  readonly startedAt: string
  readonly turnOrder: readonly TurnOrderEntryView[]
  readonly turnsCompleted: number
  readonly round: number
  readonly currentTurn: TurnOrderEntryView
}

const MIN_PARTICIPANTS = 2
const MAX_PARTICIPANTS = 6

/**
 * Estado de la batalla en curso (HU-17, RF-17): la cola de turnos INMUTABLE y
 * un unico contador de progreso, `turnsCompleted`.
 *
 * Una sola fuente de verdad: la posicion activa (`turnsCompleted mod n`) y la
 * ronda (`floor(turnsCompleted / n) + 1`) se DERIVAN, no se guardan aparte.
 * Por eso avanzar un turno no puede tocar el orden, y volver al primero tras
 * el ultimo es aritmetica, no un nuevo sorteo.
 */
export class BattleState {
  readonly startedAt: Date
  readonly turnOrder: readonly TurnOrderEntry[]
  readonly turnsCompleted: number

  private constructor(
    startedAt: Date,
    turnOrder: readonly TurnOrderEntry[],
    turnsCompleted: number,
  ) {
    this.startedAt = startedAt
    this.turnOrder = turnOrder
    this.turnsCompleted = turnsCompleted
  }

  /** Inicia una batalla con la cola YA generada. `turnsCompleted = 0`. */
  static start(turnOrder: readonly TurnOrderEntry[], startedAt: Date): BattleState {
    return BattleState.restore({ startedAt, turnOrder, turnsCompleted: 0 })
  }

  /** Reconstruye desde persistencia, con las comprobaciones estructurales de la cola. */
  static restore(snapshot: BattleStateSnapshot): BattleState {
    if (Number.isNaN(snapshot.startedAt.getTime())) {
      throw new DomainError('La fecha de inicio de la batalla no es valida.')
    }

    if (
      !Number.isInteger(snapshot.turnsCompleted) ||
      snapshot.turnsCompleted < 0 ||
      !Number.isSafeInteger(snapshot.turnsCompleted)
    ) {
      throw new DomainError('turnsCompleted debe ser un entero no negativo.')
    }

    const order = snapshot.turnOrder

    if (order.length < MIN_PARTICIPANTS || order.length > MAX_PARTICIPANTS) {
      throw new InvalidBattleRosterError(
        `La cola de turnos debe tener entre ${String(MIN_PARTICIPANTS)} y ${String(MAX_PARTICIPANTS)} participantes.`,
      )
    }

    const keys = new Set<string>()
    const humans = new Set<string>()

    for (const entry of order) {
      const key = memberKey(entry)

      if (keys.has(key)) {
        throw new InvalidBattleRosterError(`El participante ${key} esta duplicado en la cola.`)
      }
      keys.add(key)

      if (entry.kind === ParticipantKind.Human) {
        if (entry.playerId === null || humans.has(entry.playerId)) {
          throw new InvalidBattleRosterError('La cola contiene un jugador ausente o repetido.')
        }
        humans.add(entry.playerId)
      } else if (entry.playerId !== null) {
        throw new InvalidBattleRosterError('Un participante AI no lleva jugador en la cola.')
      }
    }

    return new BattleState(
      snapshot.startedAt,
      Object.freeze(order.map((entry) => Object.freeze({ ...entry }))),
      snapshot.turnsCompleted,
    )
  }

  get size(): number {
    return this.turnOrder.length
  }

  /** Posicion activa en la cola (indice 0-based). Derivada de `turnsCompleted`. */
  get currentPosition(): number {
    return this.turnsCompleted % this.turnOrder.length
  }

  /** Numero de ronda (empieza en 1). Derivado de `turnsCompleted`. */
  get round(): number {
    return Math.floor(this.turnsCompleted / this.turnOrder.length) + 1
  }

  get currentEntry(): TurnOrderEntry {
    const entry = this.turnOrder[this.currentPosition]

    if (entry === undefined) {
      throw new DomainError('La cola de turnos no tiene una posicion activa.')
    }

    return entry
  }

  /**
   * Cierra el turno activo y avanza al siguiente elemento de la cola. Devuelve
   * un estado NUEVO con la MISMA cola (misma referencia, mismo orden).
   */
  completeTurn(): BattleState {
    return new BattleState(this.startedAt, this.turnOrder, this.turnsCompleted + 1)
  }

  toSnapshot(): BattleStateSnapshot {
    return {
      startedAt: this.startedAt,
      turnOrder: this.turnOrder.map((entry) => ({ ...entry })),
      turnsCompleted: this.turnsCompleted,
    }
  }

  toView(battleId: string): BattleView {
    const withPosition = (entry: TurnOrderEntry, position: number): TurnOrderEntryView => ({
      position,
      ...entry,
    })

    return {
      battleId,
      startedAt: this.startedAt.toISOString(),
      turnOrder: this.turnOrder.map(withPosition),
      turnsCompleted: this.turnsCompleted,
      round: this.round,
      currentTurn: withPosition(this.currentEntry, this.currentPosition),
    }
  }
}
