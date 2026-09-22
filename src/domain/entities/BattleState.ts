import { DomainError } from '../errors/DomainError'
import { InvalidBattleRosterError } from '../errors/BattleErrors'
import { battleDeadline, turnDeadline } from '../policies/BattleTimingPolicy'
import {
  Combatant,
  type CombatantKey,
  type CombatantSnapshot,
  type CombatantView,
} from './Combatant'
import { ParticipantKind } from './Participant'
import { memberKey, type TurnOrderEntry } from './TurnOrder'

export interface BattleStateSnapshot {
  readonly startedAt: Date
  readonly turnOrder: readonly TurnOrderEntry[]
  readonly turnsCompleted: number
  /**
   * HU-21: instante en que arranco el turno vigente. Ausente en las batallas
   * anteriores a HU-21: el turno se considera iniciado en `startedAt` (contrato
   * §12), sin rellenar el documento ni migrar nada.
   */
  readonly turnStartedAt?: Date
  /**
   * HU-18: snapshot de combate (perfil congelado y Vida actual por participante).
   * Ausente o `null` en las batallas anteriores a HU-18: se restauran sin Vida y
   * no admiten ataque, sin consultar a Player-Inventory ni rellenar valores.
   */
  readonly combatants?: readonly CombatantSnapshot[] | null
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
  /**
   * HU-18 (aditivo): la Vida de cada participante, en el MISMO orden que la cola y
   * con la misma identidad `(teamLabel, seat)`. Es el UNICO sitio donde viaja la
   * Vida. Vacio en una batalla anterior a HU-18. Nunca lleva Ataque, Defensa, Dano
   * ni efectos.
   */
  readonly combatants: readonly CombatantView[]
  /**
   * HU-21 (aditivo): instantes ABSOLUTOS en que vencen el turno y la batalla, para
   * que Web pueda mostrar las cuentas atras con el reloj del servidor. Presente
   * mientras la batalla esta en curso; AUSENTE en la vista final y en vistas
   * anteriores a HU-21 (contrato §6.3). No es autoridad: llegar a 0 en pantalla no
   * ejecuta nada.
   */
  readonly deadlines?: BattleViewDeadlines
}

/** Vencimientos publicados en la vista (contrato §6.3). */
export interface BattleViewDeadlines {
  readonly turnEndsAt: string
  readonly battleEndsAt: string
}

/** Opciones de `BattleState.toView`: la vista final se construye sin `deadlines`. */
export interface BattleViewOptions {
  readonly withDeadlines?: boolean
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
  /** HU-21: instante en que arranco el turno vigente (para su temporizador de 30 s). */
  readonly turnStartedAt: Date
  /** Snapshot de combate por participante (HU-18); `null` en una batalla anterior a HU-18. */
  readonly combatants: readonly Combatant[] | null

  private constructor(
    startedAt: Date,
    turnOrder: readonly TurnOrderEntry[],
    turnsCompleted: number,
    combatants: readonly Combatant[] | null,
    turnStartedAt: Date,
  ) {
    this.startedAt = startedAt
    this.turnOrder = turnOrder
    this.turnsCompleted = turnsCompleted
    this.combatants = combatants
    this.turnStartedAt = turnStartedAt
  }

  /**
   * Inicia una batalla con la cola YA generada. `turnsCompleted = 0`. `combatants`
   * es el snapshot de combate (HU-18); sin el, la batalla no admite ataque.
   */
  static start(
    turnOrder: readonly TurnOrderEntry[],
    startedAt: Date,
    combatants: readonly Combatant[] | null = null,
  ): BattleState {
    return BattleState.restore({
      startedAt,
      turnStartedAt: startedAt,
      turnOrder,
      turnsCompleted: 0,
      combatants:
        combatants === null ? null : combatants.map((combatant) => combatant.toSnapshot()),
    })
  }

  /** Reconstruye desde persistencia, con las comprobaciones estructurales de la cola. */
  static restore(snapshot: BattleStateSnapshot): BattleState {
    if (Number.isNaN(snapshot.startedAt.getTime())) {
      throw new DomainError('La fecha de inicio de la batalla no es valida.')
    }

    // HU-21: una batalla anterior no trae `turnStartedAt`; su turno vigente
    // empezo con la batalla (contrato §12), sin reescribir el documento.
    const turnStartedAt = snapshot.turnStartedAt ?? snapshot.startedAt

    if (Number.isNaN(turnStartedAt.getTime())) {
      throw new DomainError('La fecha de inicio del turno no es valida.')
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
      BattleState.restoreCombatants(snapshot.combatants ?? null, keys),
      turnStartedAt,
    )
  }

  /**
   * El snapshot de combate debe corresponder EXACTAMENTE a la cola: mismos
   * participantes, ni uno mas ni uno menos, y cada uno una sola vez.
   */
  private static restoreCombatants(
    snapshots: readonly CombatantSnapshot[] | null,
    queueKeys: ReadonlySet<string>,
  ): readonly Combatant[] | null {
    if (snapshots === null) {
      return null
    }

    const combatants = snapshots.map((snapshot) => Combatant.restore(snapshot))
    const seen = new Set(combatants.map((combatant) => memberKey(combatant)))

    if (
      combatants.length !== queueKeys.size ||
      seen.size !== combatants.length ||
      [...queueKeys].some((key) => !seen.has(key))
    ) {
      throw new InvalidBattleRosterError(
        'El snapshot de combate no corresponde exactamente a los participantes de la cola.',
      )
    }

    return Object.freeze(combatants)
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
   *
   * HU-19 (`hu-19-skills-v1` §5): con snapshot de combate, cerrar el turno tambien
   * cierra el turno PROPIO de quien lo termina (a cada una de sus habilidades en recarga
   * le falta un turno menos) y abre el turno propio del siguiente (recupera +2 de Poder,
   * con tope). Es la unica regla de avance: `attack`, `useSkill` y el avance de HU-17 la
   * comparten, asi que ninguna accion puede olvidarse de la recarga ni de la regeneracion.
   *
   * HU-21 (contrato §4.1): el avance SALTA a los participantes sin Vida; cada
   * posicion saltada cuenta como turno completado (`turnsCompleted` sube y la
   * ronda se deriva igual). Los saltados no abren ni cierran turno propio: no
   * juegan. Sin nadie con Vida lanza `DomainError` (una batalla en ese estado ya
   * deberia haber finalizado por eliminacion).
   *
   * `at` es el instante del servidor (`ClockPort`) en que arranca el turno
   * siguiente: es el origen de su temporizador de 30 s.
   */
  completeTurn(at: Date): BattleState {
    const size = this.turnOrder.length
    const finishing = this.currentEntry

    if (this.combatants === null) {
      // Batalla anterior a HU-18: sin Vida no hay saltos que dar.
      return new BattleState(this.startedAt, this.turnOrder, this.turnsCompleted + 1, null, at)
    }

    let advance = 1

    while (
      advance <= size &&
      !BattleState.hasLifeAt(this.turnOrder, this.turnsCompleted + advance, this.combatants)
    ) {
      advance += 1
    }

    if (advance > size) {
      throw new DomainError('No queda ningun participante con Vida al que ceder el turno.')
    }

    const starting = this.turnOrder[(this.turnsCompleted + advance) % size]
    const same = (combatant: Combatant, entry: CombatantKey | undefined): boolean =>
      combatant.teamLabel === entry?.teamLabel && combatant.seat === entry.seat

    const advanced = this.combatants.map((combatant) => {
      const closed = same(combatant, finishing) ? combatant.closeOwnTurn() : combatant

      return same(closed, starting) ? closed.openOwnTurn() : closed
    })
    // Sin recargas que cerrar ni Poder que regenerar (batalla anterior a HU-19, o nada que
    // cambie) el snapshot se conserva TAL CUAL: misma referencia, ningun objeto nuevo.
    const unchanged = advanced.every((combatant, index) => combatant === this.combatants?.[index])

    return new BattleState(
      this.startedAt,
      this.turnOrder,
      this.turnsCompleted + advance,
      unchanged ? this.combatants : Object.freeze(advanced),
      at,
    )
  }

  /** `true` si el participante de esa posicion (absoluta) existe y tiene Vida. */
  private static hasLifeAt(
    turnOrder: readonly TurnOrderEntry[],
    position: number,
    combatants: readonly Combatant[],
  ): boolean {
    const entry = turnOrder[position % turnOrder.length]

    if (entry === undefined) {
      return false
    }

    const combatant = combatants.find(
      (candidate) => candidate.teamLabel === entry.teamLabel && candidate.seat === entry.seat,
    )

    return combatant?.alive ?? false
  }

  /**
   * HU-11 aplicada al FIN de la batalla (HU-21): devuelve el estado con el Poder
   * de todos los combatientes al maximo. Sin cambios (o sin snapshot) devuelve
   * ESTA misma instancia: la vista final no crea objetos que no hacen falta.
   */
  restoreAllPower(): BattleState {
    if (this.combatants === null) {
      return this
    }

    /** Maximo que le falta por restaurar, o `null` si no hay nada que hacer. */
    const powerToRestore = (combatant: Combatant): number | null => {
      const max = combatant.profile?.maxPower

      if (combatant.currentPower === null || max === undefined || combatant.currentPower === max) {
        return null
      }

      return max
    }

    if (!this.combatants.some((combatant) => powerToRestore(combatant) !== null)) {
      return this
    }

    return new BattleState(
      this.startedAt,
      this.turnOrder,
      this.turnsCompleted,
      Object.freeze(
        this.combatants.map((combatant) => {
          const max = powerToRestore(combatant)

          return max === null ? combatant : combatant.withPower(max)
        }),
      ),
      this.turnStartedAt,
    )
  }

  /** El combatiente de una identidad `(teamLabel, seat)`, o `undefined` si no participa. */
  combatantFor(key: CombatantKey): Combatant | undefined {
    return this.combatants?.find(
      (combatant) => combatant.teamLabel === key.teamLabel && combatant.seat === key.seat,
    )
  }

  /** Otro estado con UN combatiente reemplazado; los demas y la cola no se tocan. */
  withCombatant(updated: Combatant): BattleState {
    if (this.combatants === null) {
      throw new DomainError(
        'Una batalla sin snapshot de combate no tiene combatientes que cambiar.',
      )
    }

    if (this.combatantFor(updated) === undefined) {
      throw new DomainError('El combatiente no participa en la batalla.')
    }

    return new BattleState(
      this.startedAt,
      this.turnOrder,
      this.turnsCompleted,
      Object.freeze(
        this.combatants.map((combatant) =>
          combatant.teamLabel === updated.teamLabel && combatant.seat === updated.seat
            ? updated
            : combatant,
        ),
      ),
      this.turnStartedAt,
    )
  }

  toSnapshot(): BattleStateSnapshot {
    return {
      startedAt: this.startedAt,
      turnStartedAt: this.turnStartedAt,
      turnOrder: this.turnOrder.map((entry) => ({ ...entry })),
      turnsCompleted: this.turnsCompleted,
      combatants:
        this.combatants === null
          ? null
          : this.combatants.map((combatant) => combatant.toSnapshot()),
    }
  }

  /**
   * Vista visible de la batalla. Por defecto incluye los `deadlines` (HU-21,
   * contrato §6.3): el turno vigente y el global, en ISO, para que Web muestre
   * las cuentas atras sin fiarse de su reloj. La vista FINAL de una batalla
   * terminada se construye con `{ withDeadlines: false }` (contrato §6.2).
   */
  toView(battleId: string, options: BattleViewOptions = {}): BattleView {
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
      // Mismo orden que la cola: cada participante con su Vida. Vacio sin snapshot.
      combatants: this.turnOrder.flatMap((entry) => {
        const combatant = this.combatantFor(entry)

        return combatant === undefined ? [] : [combatant.toView()]
      }),
      ...(options.withDeadlines === false
        ? {}
        : {
            deadlines: {
              turnEndsAt: turnDeadline(this.turnStartedAt).toISOString(),
              battleEndsAt: battleDeadline(this.startedAt).toISOString(),
            },
          }),
    }
  }
}
