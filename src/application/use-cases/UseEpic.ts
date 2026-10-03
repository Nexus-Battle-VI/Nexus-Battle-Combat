import type { BattleEvent } from '../../domain/entities/BattleEvent'
import type {
  BattleRoom,
  EpicOutcome,
  EpicReadyPlan,
  ResolvedEpicEffect,
} from '../../domain/entities/BattleRoom'
import type { ActiveSkillEffect, CombatantKey } from '../../domain/entities/Combatant'
import { calculateHeal } from '../../domain/policies/HealApplicationPolicy'
import { dieFaceFromIndex } from '../../domain/policies/AttackProfile'
import type { SkillDice } from '../../domain/policies/SkillEffectPolicy'
import type { TemporalEffectAudience } from '../../domain/policies/SkillEffectPolicy'
import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import { DomainError } from '../../domain/errors/DomainError'
import {
  RoomConflictError,
  RoomNotFoundError,
  RoomAccessForbiddenError,
} from '../errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { RandomSequencePort } from '../ports/RandomSequencePort'
import type { RoomCommandLockPort } from '../ports/RoomCommandLockPort'
import type { BattleDeadlineSettler } from '../services/BattleDeadlineSettler'
import type { PersistVersusDropDecision } from '../services/PersistVersusDropDecision'

export interface UseEpicInput {
  readonly roomId: string
  /** El `sub` autenticado de la conexion: el actor NUNCA lo aporta el cliente. */
  readonly requesterId: string
  /** Identificador del comando (ADR-020): repetirlo devuelve el resultado ya calculado. */
  readonly commandId: string
  /**
   * UN objetivo, SOLO si algun efecto de la epica lo necesita (ALLY/OPPONENT). Ausente para
   * una epica cuyos efectos sean todos SELF/ALLIED_GROUP -- no hay `epicId` que el cliente
   * elija: la UNICA epica ejecutable es la que esta congelada en el perfil del actor.
   */
  readonly target?: CombatantKey
}

export interface UseEpicResult {
  readonly event: BattleEvent
  readonly replayed: boolean
  readonly followUp: readonly BattleEvent[]
  readonly finished: BattleRoom | null
}

/**
 * Ejecuta la epica equipada durante el turno del jugador (correccion HU-19/HU-31, tras
 * GAP-HU31-CATALOG-MULTI-EFFECT). Mismo criterio de orquestacion que `UseSkill`, SIN
 * reimplementar nada:
 *
 *  1. VALIDA (`BattleRoom.planEpic`): turno, epica equipada (CA, no hay `abilityId` que
 *     elegir), efectos soportados (`EpicSkillPolicy`), recarga, Poder (siempre 0, nunca
 *     insuficiente) y objetivo (solo si algun efecto lo exige). Todo ANTES de sortear.
 *  2. RESUELVE (aqui): tira los dados de cada bono/magnitud UNA sola vez cada uno, con
 *     `RandomSequencePort` (nunca un segundo generador) -- mismo principio que
 *     `UseSkill.resolveTemporalEffects`.
 *  3. APLICA (`BattleRoom.applyEpic`): Poder + recarga + TODOS los efectos correspondientes +
 *     evento + `commandId` + turno avanzado, como UNA sola version nueva.
 *  4. PERSISTE con UNA escritura, igual que `UseSkill`.
 *
 * No llama a Player-Inventory ni a Catalog: la epica, su costo y su recarga salen del
 * snapshot congelado de la sala.
 */
export class UseEpic {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly clock: ClockPort,
    private readonly sequence: RandomSequencePort,
    private readonly lock: RoomCommandLockPort,
    private readonly settler: BattleDeadlineSettler | null = null,
    private readonly versusDrop: PersistVersusDropDecision | null = null,
  ) {}

  execute(input: UseEpicInput): Promise<UseEpicResult> {
    return this.lock.run(input.roomId, () => this.executeExclusively(input))
  }

  private async executeExclusively(input: UseEpicInput): Promise<UseEpicResult> {
    let room = await this.rooms.findById(input.roomId)

    if (room === null) {
      throw new RoomNotFoundError(input.roomId)
    }

    if (!room.isParticipant(input.requesterId)) {
      throw new RoomAccessForbiddenError(input.roomId)
    }

    if (this.settler !== null && !room.hasHandledCommand(input.commandId)) {
      room = await this.settler.settle(room)
    }

    const plan = room.planEpic(input.requesterId, input.commandId, input.target)

    if (plan.kind === 'replay') {
      return { event: plan.event, replayed: true, followUp: [], finished: null }
    }

    const outcome = this.resolve(plan)
    const actionSeq = room.lastSeq + 1
    const next = room.applyEpic(plan, outcome, input.commandId, this.clock.now())

    return this.persist(room, next, actionSeq, input)
  }

  /** Tira los dados de cada efecto UNA sola vez; nunca vuelve a sortear tras un conflicto. */
  private resolve(plan: EpicReadyPlan): EpicOutcome {
    const resolvedEffects: ResolvedEpicEffect[] = []

    for (const stat of plan.effectPlan.temporalStats) {
      const amount = stat.bonus.fixed + this.roll(stat.bonus.dice)

      for (const targetKey of this.audienceKeys(plan, stat.audience)) {
        resolvedEffects.push({
          targetKey,
          effect: {
            sourceAbilityId: plan.epic.epicProductId,
            sourceCombatant: plan.attackerEntry,
            statistic: stat.statistic,
            operation: stat.operation,
            amount,
            remainingOwnTurns: stat.durationTurns,
          } satisfies ActiveSkillEffect,
        })
      }
    }

    for (const immunity of plan.effectPlan.immunities) {
      resolvedEffects.push({
        targetKey: plan.attackerEntry,
        effect: {
          sourceAbilityId: plan.epic.epicProductId,
          sourceCombatant: plan.attackerEntry,
          immunityCode: immunity.immunityCode,
          remainingOwnTurns: immunity.durationTurns,
        },
      })
    }

    const healAmount =
      plan.effectPlan.instantHeals.length === 0
        ? null
        : plan.effectPlan.instantHeals.reduce(
            (total, heal) => total + heal.bonus.fixed + this.roll(heal.bonus.dice),
            0,
          )

    const damageAmount =
      plan.effectPlan.directDamage.length === 0
        ? null
        : plan.effectPlan.directDamage.reduce(
            (total, damage) => total + damage.bonus.fixed + this.roll(damage.bonus.dice),
            0,
          )

    const reviveMaxHealth = plan.target?.profile?.maxHealth ?? 0
    const reviveAmount =
      plan.effectPlan.revives.length === 0
        ? null
        : plan.effectPlan.revives.reduce(
            (total, revive) => total + calculateHeal(reviveMaxHealth, revive.magnitude.basisPoints),
            0,
          )

    return { resolvedEffects, healAmount, damageAmount, reviveAmount }
  }

  /** A que combatientes concretos afecta una audiencia (`SELF`/`OPPONENT`/`ALLY` son uno solo). */
  private audienceKeys(
    plan: EpicReadyPlan,
    audience: TemporalEffectAudience,
  ): readonly CombatantKey[] {
    if (audience === 'SELF') {
      return [plan.attackerEntry]
    }

    if (audience === 'ALLIED_GROUP') {
      return plan.recipients.map((recipient) => recipient.entry)
    }

    // OPPONENT o ALLY: `planEpic` ya exigio y resolvio un unico `targetEntry` para esta audiencia.
    return plan.targetEntry === null ? [] : [plan.targetEntry]
  }

  /** La cara de un dado es `dieFaceFromIndex`, igual que el resto de HU-19; el indice sale de HU-24. */
  private roll(dice: readonly SkillDice[]): number {
    let total = 0

    for (const die of dice) {
      for (let count = 0; count < die.count; count += 1) {
        total += dieFaceFromIndex(this.sequence.nextIndex(), die.sides)
      }
    }

    return total
  }

  private async persist(
    room: BattleRoom,
    next: BattleRoom,
    actionSeq: number,
    input: UseEpicInput,
  ): Promise<UseEpicResult> {
    try {
      const resolved =
        this.versusDrop === null ? next : await this.versusDrop.execute(room, next, actionSeq)
      const saved = await this.rooms.save(resolved, room.version)
      const event = saved.events.find((candidate) => candidate.seq === actionSeq)

      if (event === undefined) {
        throw new DomainError('La epica se guardo sin su evento.')
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

  private async resolveConflict(
    input: UseEpicInput,
    conflict: RoomConflictError,
  ): Promise<UseEpicResult> {
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

    return { event, replayed: true, followUp: [], finished: null }
  }
}
