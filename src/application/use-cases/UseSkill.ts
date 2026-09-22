import type { BattleEvent } from '../../domain/entities/BattleEvent'
import type { BattleRoom, SkillOutcome, SkillReadyPlan } from '../../domain/entities/BattleRoom'
import type { CombatantKey } from '../../domain/entities/Combatant'
import { UnsupportedCombatProfileError } from '../../domain/errors/BattleErrors'
import { DomainError } from '../../domain/errors/DomainError'
import { dieFaceFromIndex } from '../../domain/policies/AttackProfile'
import type { SkillDice } from '../../domain/policies/SkillEffectPolicy'
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
import type { ExecuteBasicAttack } from './ExecuteBasicAttack'
import { prepareAttack, type AttackParticipant } from './PrepareAttack'
import { ResolveAttack } from './ResolveAttack'

export interface UseSkillInput {
  readonly roomId: string
  /** El `sub` autenticado de la conexion: el actor NUNCA lo aporta el cliente. */
  readonly requesterId: string
  /** Identificador del comando (ADR-020): repetirlo devuelve el resultado ya calculado. */
  readonly commandId: string
  /** `productId` de Catalog de la habilidad. Solo un identificador: el resto sale del snapshot. */
  readonly abilityId: string
  /** UN objetivo, con la identidad estable `(teamLabel, seat)`. */
  readonly target: CombatantKey
}

export interface UseSkillResult {
  /** El evento persistido: `skillUsed`, o `basicAttackResolved` con `degradedFrom` si el Poder no alcanzaba. */
  readonly event: BattleEvent
  /**
   * `true` si el `commandId` ya se habia procesado: no se sorteo, no se guardo y NO se
   * difunde; el llamador solo lo reenvia a quien lo repitio. `false`: el evento ya esta
   * persistido y el llamador (el gateway, que ES el publicador) lo difunde.
   */
  readonly replayed: boolean
  /** HU-21: eventos guardados despues del de la accion (p. ej. `[battleFinished]`). */
  readonly followUp: readonly BattleEvent[]
  /** HU-21: la sala persistida si y solo si quedo `FINISHED`; `null` si no. */
  readonly finished: BattleRoom | null
}

/**
 * Ejecuta una habilidad especial durante el turno del jugador (HU-19, RF-19).
 *
 * Orquesta, sin reimplementar nada (contrato `hu-19-skills-v1`):
 *
 *  1. VALIDA (`BattleRoom.planSkill`): turno, objetivo, perfiles, habilidad del heroe (CA-02),
 *     efectos soportados, recarga (CA-04, CA-07) y Poder (CA-03). Todo ANTES de consumir un
 *     solo sorteo. Con Poder insuficiente NO falla: HU-11 exige forzar el ataque basico en ese
 *     turno, asi que se delega en `ExecuteBasicAttack` (el mismo flujo, sorteos y eventos de
 *     HU-18) con `degradedFrom`; el Poder y la recarga quedan intactos.
 *  2. RESUELVE la habilidad como UN ataque mejorado con HU-20: los bonos propios de la
 *     habilidad se suman al Ataque y al Dano de ESA resolucion; el porcentaje del efecto (HU-25)
 *     actua sobre el dano base ya con el bono.
 *  3. APLICA (`BattleRoom.applySkill`): Vida + Poder + recarga + evento + `commandId` + turno
 *     avanzado como UNA sola version nueva del agregado.
 *  4. PERSISTE con UNA escritura. La difusion NO ocurre aqui: se devuelve el evento ya
 *     persistido y el gateway (que es el publicador) lo difunde DESPUES.
 *
 * CONSUMO DE LA SECUENCIA HU-24, en este orden exacto:
 *
 *   1. dados del bono de Ataque de la habilidad     siempre que los tenga
 *   2. dado de Ataque                               HU-20, sin cambios
 *   3. efecto                                       1 indice, solo si es efectivo (HU-20)
 *   4. dado de Dano del heroe                       solo si es efectivo, % > 0 y el Dano es `DICE`
 *   5. dados del bono de Dano de la habilidad       solo si es efectivo y % > 0
 *
 * Los dados del bono de Ataque van ANTES que el de Ataque porque `ResolveAttack` tira el suyo
 * al invocarse y compara enseguida: asi HU-20 no cambia. Con un efecto del 0 % el dano es 0
 * sea cual sea el dado: no se consume aleatoriedad que no puede afectar al resultado. Un
 * rechazo previo consume 0.
 *
 * IDEMPOTENCIA Y CONCURRENCIA: igual que `attack`. Los comandos de una sala se serializan
 * (`RoomCommandLockPort`); un `commandId` repetido devuelve el evento ya persistido; y NUNCA
 * se vuelve a sortear tras un conflicto de version.
 *
 * No llama a Player-Inventory ni a Catalog: la habilidad, su costo y su recarga salen del
 * snapshot congelado de la sala.
 */
export class UseSkill {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly clock: ClockPort,
    private readonly sequence: RandomSequencePort,
    private readonly lock: RoomCommandLockPort,
    private readonly basicAttack: ExecuteBasicAttack,
    /** HU-21: liquidacion perezosa de vencimientos antes de validar (contrato §3). */
    private readonly settler: BattleDeadlineSettler | null = null,
    private readonly resolveAttack: ResolveAttack = new ResolveAttack(),
  ) {}

  execute(input: UseSkillInput): Promise<UseSkillResult> {
    return this.lock.run(input.roomId, () => this.executeExclusively(input))
  }

  private async executeExclusively(input: UseSkillInput): Promise<UseSkillResult> {
    let room = await this.rooms.findById(input.roomId)

    if (room === null) {
      throw new RoomNotFoundError(input.roomId)
    }

    if (!room.isParticipant(input.requesterId)) {
      throw new RoomAccessForbiddenError(input.roomId)
    }

    // HU-21 (mismo criterio que `attack`): liquidar antes de validar; un
    // `commandId` ya procesado NO liquida, devuelve su resultado tal cual.
    if (this.settler !== null && !room.hasHandledCommand(input.commandId)) {
      room = await this.settler.settle(room)
    }

    const plan = room.planSkill(input.requesterId, input.commandId, input.abilityId, input.target)

    if (plan.kind === 'replay') {
      return { event: plan.event, replayed: true, followUp: [], finished: null }
    }

    if (plan.kind === 'degraded') {
      // Ya se tiene el bloqueo de la sala: se ejecuta el ataque basico SIN volver a pedirlo.
      return this.basicAttack.executeExclusively({
        roomId: input.roomId,
        requesterId: input.requesterId,
        commandId: input.commandId,
        target: input.target,
        degradedFrom: {
          command: 'useSkill',
          abilityId: plan.abilityId,
          reason: 'INSUFFICIENT_POWER',
        },
      })
    }

    if (plan.kind === 'healSkill') {
      // Curar es DETERMINISTA (excepcion de HU-12, `HealApplicationPolicy`): no hay
      // `prepare`/`resolve` ni se consume la secuencia HU-24, a diferencia de una
      // habilidad ofensiva.
      const actionSeq = room.lastSeq + 1
      const next = room.applyHealSkill(plan, input.commandId, this.clock.now())

      return this.persist(room, next, actionSeq, input)
    }

    // A partir de aqui se consume la secuencia: todo lo que puede fallar por el perfil ya se
    // comprobo (planSkill) o se comprueba en `prepare`, que no sortea.
    const prepared = this.prepare(plan)
    const outcome = this.resolve(plan, prepared)
    // HU-21: una habilidad letal arrastra `battleFinished` en la misma escritura;
    // el evento de la ACCION es el que se construye con este `seq`.
    const actionSeq = room.lastSeq + 1
    const next = room.applySkill(plan, outcome, input.commandId, this.clock.now())

    return this.persist(room, next, actionSeq, input)
  }

  /**
   * Guarda el agregado ya mutado (por `applySkill` o `applyHealSkill`) como UNA
   * escritura y arma el resultado, mismo criterio para ambas habilidades: no hay
   * nada especifico de dano ni de curacion en la persistencia.
   */
  private async persist(
    room: BattleRoom,
    next: BattleRoom,
    actionSeq: number,
    input: UseSkillInput,
  ): Promise<UseSkillResult> {
    try {
      const saved = await this.rooms.save(next, room.version)
      const event = saved.events.find((candidate) => candidate.seq === actionSeq)

      if (event === undefined) {
        throw new DomainError('La habilidad se guardo sin su evento.')
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
  private prepare(plan: SkillReadyPlan): ReturnType<typeof prepareAttack> {
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

  private resolve(plan: SkillReadyPlan, prepared: ReturnType<typeof prepareAttack>): SkillOutcome {
    // 1) Dados del bono de Ataque de la habilidad, ANTES del dado de Ataque de HU-20.
    const attackBonus = plan.attackBonus.fixed + this.roll(plan.attackBonus.dice)
    // 2-3) HU-20: dado de Ataque, Ataque > Defensa y, si es efectivo, el efecto de HU-25.
    const resolution = this.resolveAttack.execute({
      attack: { base: prepared.attack.base + attackBonus, dice: prepared.attack.dice },
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
        attackBonus,
        damageBonus: null,
      }
    }

    const percent = resolution.effect.percent
    const damage = this.materializeDamage(plan, percent)

    return {
      attackValue: resolution.attackValue,
      defenseValue: resolution.defenseValue,
      effective: true,
      effect: resolution.effect.effect,
      percent,
      baseDamage: damage.base,
      attackBonus,
      damageBonus: damage.bonus,
    }
  }

  /**
   * Dano base = tirada (o valor fijo) del Dano del heroe + bono de Dano de la habilidad (fijo +
   * dados). `FIXED` no sortea. Los dados solo se tiran con un porcentaje > 0: con 0 % el
   * resultado es 0 sea cual sea el dado, asi que si hicieran falta dados no se tira nada y el
   * dano base queda en `null`.
   */
  private materializeDamage(
    plan: SkillReadyPlan,
    percent: number,
  ): { readonly base: number | null; readonly bonus: number | null } {
    const needsDice = plan.damage.mode === 'DICE' || plan.damageBonus.dice.length > 0

    if (percent === 0 && needsDice) {
      return { base: null, bonus: null }
    }

    // 4) Dado de Dano del heroe, 5) dados del bono de Dano.
    const hero =
      plan.damage.mode === 'FIXED'
        ? plan.damage.amount
        : this.roll([{ count: plan.damage.count, sides: plan.damage.sides }])
    const bonus = plan.damageBonus.fixed + this.roll(plan.damageBonus.dice)

    return { base: hero + bonus, bonus }
  }

  /** La cara de un dado es `dieFaceFromIndex`, la misma del dado de Ataque; el indice sale de la secuencia. */
  private roll(dice: readonly SkillDice[]): number {
    let total = 0

    for (const die of dice) {
      for (let roll = 0; roll < die.count; roll += 1) {
        total += dieFaceFromIndex(this.sequence.nextIndex(), die.sides)
      }
    }

    return total
  }

  /**
   * El guardado fallo por version: NO se vuelve a sortear. Se relee la sala y, si el comando ya
   * esta procesado, se devuelve ese resultado; si no, se propaga el conflicto (el cliente
   * reintenta con el mismo `commandId`).
   */
  private async resolveConflict(
    input: UseSkillInput,
    conflict: RoomConflictError,
  ): Promise<UseSkillResult> {
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

    // Un reintento idempotente no liquida ni finaliza nada.
    return { event, replayed: true, followUp: [], finished: null }
  }
}

/** Adapta el perfil congelado a lo que HU-20 lee (`prepareAttack`), sin copiar mas de lo necesario. */
const toAttackParticipant = (profile: SkillReadyPlan['attackerProfile']): AttackParticipant => ({
  heroId: profile.heroId,
  subtype: profile.subtype,
  activeEffects: profile.activeEffects,
  effectiveStats: { attack: profile.attack, defense: profile.defense },
})
