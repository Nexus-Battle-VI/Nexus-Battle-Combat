import type { BattleEvent, DegradedFrom } from '../../domain/entities/BattleEvent'
import type {
  BattleRoom,
  BasicAttackOutcome,
  BasicAttackReadyPlan,
} from '../../domain/entities/BattleRoom'
import type { CombatantKey } from '../../domain/entities/Combatant'
import { UnsupportedCombatProfileError } from '../../domain/errors/BattleErrors'
import { DomainError } from '../../domain/errors/DomainError'
import { dieFaceFromIndex } from '../../domain/policies/AttackProfile'
import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { RandomSequencePort } from '../ports/RandomSequencePort'
import type { RoomCommandLockPort } from '../ports/RoomCommandLockPort'
import type { BattleDeadlineSettler } from '../services/BattleDeadlineSettler'
import { prepareAttack, type AttackParticipant } from './PrepareAttack'
import { ResolveAttack } from './ResolveAttack'

export interface ExecuteBasicAttackInput {
  readonly roomId: string
  /** El `sub` autenticado de la conexion: el atacante NUNCA lo aporta el cliente. */
  readonly requesterId: string
  /** Identificador del comando (ADR-020): repetirlo devuelve el resultado ya calculado. */
  readonly commandId: string
  /** UN objetivo, con la identidad estable `(teamLabel, seat)`. */
  readonly target: CombatantKey
  /**
   * HU-19: solo lo pone `UseSkill` cuando una habilidad se degrada a ataque basico (HU-11).
   * El evento lo lleva para explicar por que hubo un ataque basico; el resto del flujo es
   * exactamente el de `attack`. Un cliente nunca lo aporta: el handler de `attack` no lo lee.
   */
  readonly degradedFrom?: DegradedFrom
}

export interface ExecuteBasicAttackResult {
  /** El evento persistido de la accion (`basicAttackResolved`). */
  readonly event: BattleEvent
  /**
   * `true` si el `commandId` ya se habia procesado: no se sorteo, no se guardo y NO se
   * difunde; el llamador solo lo reenvia a quien lo repitio. `false`: el evento ya esta
   * persistido y el llamador (el gateway, que ES el publicador) lo difunde.
   */
  readonly replayed: boolean
  /**
   * HU-21: eventos guardados DESPUES del de la accion en esa misma escritura.
   * Normalmente `[]`; con un golpe letal trae `[battleFinished]`. El llamador
   * debe difundirlos en orden TRAS el evento de la accion y ANTES de liberar.
   */
  readonly followUp: readonly BattleEvent[]
  /**
   * HU-21: la sala persistida SI y SOLO SI quedo `FINISHED`; `null` en cualquier
   * otro caso. El llamador decide con esto si invoca al `BattleFinalizer`
   * (siempre despues de difundir).
   */
  readonly finished: BattleRoom | null
}

/**
 * Ejecuta un ataque basico durante el turno del jugador (HU-18, RF-18).
 *
 * Orquesta, sin reimplementar nada:
 *
 *  1. VALIDA (`BattleRoom.planBasicAttack`): turno, objetivo unico y valido, perfiles,
 *     Vida y Dano soportado. Todo ANTES de consumir un solo sorteo.
 *  2. RESUELVE con HU-20: `prepareAttack` + `ResolveAttack` (dado de Ataque; si el
 *     golpe es efectivo, el efecto de HU-25) y, si corresponde, el dado de Dano.
 *  3. APLICA (`BattleRoom.applyBasicAttack`): Vida + evento + `commandId` + turno
 *     avanzado como UNA sola version nueva del agregado.
 *  4. PERSISTE con UNA escritura. La difusion NO ocurre aqui: se devuelve el evento ya
 *     persistido y el adaptador de entrada (el gateway, que es el publicador) lo
 *     difunde SOLO despues de que este caso de uso termina: persistir antes de
 *     difundir se cumple por construccion. Asi el publicador no se inyecta en el caso
 *     de uso y no hay dependencia circular gateway -> caso de uso -> gateway.
 *
 * CONSUMO DE LA SECUENCIA HU-24, en este orden exacto:
 *
 *   1. dado de Ataque       `dice.count` indices           (HU-20, sin cambios)
 *   2. efecto               1 indice, solo si es efectivo  (HU-20, sin cambios)
 *   3. dado de Dano         `damage.count` indices, solo si es efectivo, el
 *                           porcentaje es > 0 y el Dano es `DICE`
 *
 * Con un efecto del 0 % el dano es 0 sea cual sea el dado: no se consume
 * aleatoriedad que no puede afectar al resultado. Un rechazo previo consume 0.
 *
 * IDEMPOTENCIA Y CONCURRENCIA:
 *  - Los comandos de una sala se serializan (`RoomCommandLockPort`): el segundo relee
 *    la sala ya actualizada y termina como repeticion o `NOT_YOUR_TURN`, sin sorteos.
 *  - Un `commandId` repetido devuelve el evento ya persistido (`replayed`).
 *  - NUNCA se vuelve a sortear tras un conflicto de version: se relee y, si el
 *    comando ya se proceso, se devuelve ese resultado; si no, el conflicto se
 *    propaga y el cliente reintenta con el mismo `commandId`. Reintentar a ciegas
 *    resolveria otra aleatoriedad para el mismo comando.
 *
 * No consume ni lee Poder: el ataque basico no tiene costo (HU-18). No llama a
 * Player-Inventory ni a Catalog: todo sale del snapshot de combate congelado.
 */
export class ExecuteBasicAttack {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly clock: ClockPort,
    private readonly sequence: RandomSequencePort,
    private readonly lock: RoomCommandLockPort,
    /**
     * HU-21: liquidacion perezosa de los vencimientos de la sala antes de validar
     * (contrato §3). Opcional para no romper construcciones de pruebas que no
     * necesitan vencimientos; en produccion SIEMPRE se inyecta.
     */
    private readonly settler: BattleDeadlineSettler | null = null,
    private readonly resolveAttack: ResolveAttack = new ResolveAttack(),
  ) {}

  execute(input: ExecuteBasicAttackInput): Promise<ExecuteBasicAttackResult> {
    return this.lock.run(input.roomId, () => this.executeExclusively(input))
  }

  /**
   * El flujo completo SIN tomar el bloqueo de la sala. Es publico para que `UseSkill`, que ya
   * tiene el bloqueo de esa sala, ejecute el ataque basico al que se degrada una habilidad
   * sin volver a pedirlo: el bloqueo no es reentrante y esperaria a si mismo. Nadie mas debe
   * llamarlo fuera de un `lock.run`.
   */
  async executeExclusively(input: ExecuteBasicAttackInput): Promise<ExecuteBasicAttackResult> {
    let room = await this.rooms.findById(input.roomId)

    if (room === null) {
      throw new RoomNotFoundError(input.roomId)
    }

    if (!room.isParticipant(input.requesterId)) {
      throw new RoomAccessForbiddenError(input.roomId)
    }

    // HU-21 (contrato §3): todo comando de combate liquida ANTES de validar, para
    // que un golpe que llega tras el vencimiento del turno (o de la batalla) no se
    // ejecute nunca sobre un turno o una batalla vencidos. NO se liquida antes de
    // un reintento idempotente: un `commandId` ya procesado devuelve su evento
    // aunque despues haya vencido algo.
    if (this.settler !== null && !room.hasHandledCommand(input.commandId)) {
      room = await this.settler.settle(room)
    }

    const plan = room.planBasicAttack(input.requesterId, input.commandId, input.target)

    if (plan.kind === 'replay') {
      return { event: plan.event, replayed: true, followUp: [], finished: null }
    }

    // A partir de aqui se consume la secuencia: todo lo que puede fallar por el perfil
    // ya se comprobo (planBasicAttack) o se comprueba en `prepare`, que no sortea.
    const prepared = this.prepare(plan)
    const outcome = this.resolve(plan, prepared)
    // HU-21: la accion puede arrastrar `battleFinished` en la misma escritura, asi
    // que el evento de la ACCION es el que se construye con este `seq`, no el
    // ultimo guardado.
    const actionSeq = room.lastSeq + 1
    const next = room.applyBasicAttack(
      plan,
      outcome,
      input.commandId,
      this.clock.now(),
      input.degradedFrom,
    )

    try {
      const saved = await this.rooms.save(next, room.version)
      const event = saved.events.find((candidate) => candidate.seq === actionSeq)

      if (event === undefined) {
        throw new DomainError('El ataque se guardo sin su evento.')
      }

      return {
        event,
        replayed: false,
        followUp: saved.events.filter((candidate) => candidate.seq > actionSeq),
        finished: saved.status === BattleRoomStatus.Finished ? saved : null,
      }
    } catch (error: unknown) {
      if (error instanceof RoomConflictError) {
        return this.resolveConflict(input, error)
      }

      throw error
    }
  }

  /** `prepareAttack` es puro (no sortea); un perfil que HU-20 no sabe preparar es un perfil no soportado. */
  private prepare(plan: BasicAttackReadyPlan): ReturnType<typeof prepareAttack> {
    try {
      return prepareAttack(
        toAttackParticipant(plan.attackerProfile),
        toAttackParticipant(plan.targetProfile),
      )
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        throw new UnsupportedCombatProfileError(error.message)
      }

      throw error
    }
  }

  private resolve(
    plan: BasicAttackReadyPlan,
    prepared: ReturnType<typeof prepareAttack>,
  ): BasicAttackOutcome {
    const resolution = this.resolveAttack.execute({
      attack: prepared.attack,
      defenseValue: prepared.defenseValue,
      table: prepared.table,
      sequence: this.sequence,
    })

    if (!resolution.effective) {
      return {
        attackValue: resolution.attackValue,
        defenseValue: resolution.defenseValue,
        effective: false,
        effect: null,
        percent: null,
        baseDamage: null,
      }
    }

    const percent = resolution.effect.percent

    return {
      attackValue: resolution.attackValue,
      defenseValue: resolution.defenseValue,
      effective: true,
      effect: resolution.effect.effect,
      percent,
      baseDamage: this.materializeDamage(plan, percent),
    }
  }

  /**
   * Dano base del atacante: `FIXED` se usa tal cual (sin sorteo); `DICE` se tira con la
   * secuencia HU-24 solo si el porcentaje es > 0 (con 0 % el resultado es 0 sea cual
   * sea el dado). La cara de un dado es `dieFaceFromIndex`, la misma del dado de Ataque.
   */
  private materializeDamage(plan: BasicAttackReadyPlan, percent: number): number | null {
    if (plan.damage.mode === 'FIXED') {
      return plan.damage.amount
    }

    if (percent === 0) {
      return null
    }

    let total = 0

    for (let roll = 0; roll < plan.damage.count; roll += 1) {
      total += dieFaceFromIndex(this.sequence.nextIndex(), plan.damage.sides)
    }

    return total
  }

  /**
   * El guardado fallo por version: NO se vuelve a sortear. Se relee la sala y, si el
   * comando ya esta procesado, se devuelve ese resultado; si no, se propaga el
   * conflicto (el cliente reintenta con el mismo `commandId`).
   */
  private async resolveConflict(
    input: ExecuteBasicAttackInput,
    conflict: RoomConflictError,
  ): Promise<ExecuteBasicAttackResult> {
    const current = await this.rooms.findById(input.roomId)
    const handled = current?.handledCommands.find(
      (candidate) => candidate.commandId === input.commandId,
    )
    const event =
      handled === undefined
        ? undefined
        : current?.events.find((candidate) => candidate.seq === handled.seq)

    if (event === undefined) {
      throw conflict
    }

    // Un reintento idempotente no liquida ni finaliza nada: la escritura que gano
    // ya hizo lo que tocaba.
    return { event, replayed: true, followUp: [], finished: null }
  }
}

/** Adapta el perfil congelado a lo que HU-20 lee (`prepareAttack`), sin copiar mas de lo necesario. */
const toAttackParticipant = (
  profile: BasicAttackReadyPlan['attackerProfile'],
): AttackParticipant => ({
  heroId: profile.heroId,
  subtype: profile.subtype,
  activeEffects: profile.activeEffects,
  effectiveStats: { attack: profile.attack, defense: profile.defense },
})
