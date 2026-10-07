import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { CombatantKey } from '../../domain/entities/Combatant'
import {
  DecisionStateUnavailableError,
  NoLegalDecisionActionsError,
} from '../../domain/errors/DecisionContractErrors'
import type { DecisionActionTarget, LegalAction } from '../../domain/decision/LegalAction'
import { legalActionIdentity } from '../../domain/decision/ActionIdentity'
import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import {
  EpicOnCooldownError,
  EpicTargetRequiredError,
  InsufficientPowerForHealError,
  InvalidHealTargetError,
  InvalidTargetError,
  SameTeamTargetError,
  SkillOnCooldownError,
  TargetUnavailableError,
  UnsupportedEpicEffectError,
  UnsupportedSkillEffectError,
} from '../../domain/errors/BattleErrors'

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0
const compareKey = (left: CombatantKey, right: CombatantKey): number =>
  compareText(left.teamLabel, right.teamLabel) || left.seat - right.seat
const immutableKey = (key: CombatantKey): CombatantKey =>
  Object.freeze({ teamLabel: key.teamLabel, seat: key.seat })
const combatantTarget = (key: CombatantKey): DecisionActionTarget =>
  Object.freeze({ scope: 'COMBATANT' as const, combatant: immutableKey(key) })
const selfTarget: DecisionActionTarget = Object.freeze({ scope: 'SELF' as const })
const alliedGroupTarget: DecisionActionTarget = Object.freeze({ scope: 'ALLIED_GROUP' as const })
const targetRank = { SELF: 0, ALLIED_GROUP: 1, COMBATANT: 2 } as const
const compareTarget = (left: DecisionActionTarget, right: DecisionActionTarget): number => {
  const byScope = targetRank[left.scope] - targetRank[right.scope]

  if (byScope !== 0 || left.scope !== 'COMBATANT' || right.scope !== 'COMBATANT') return byScope
  return compareKey(left.combatant, right.combatant)
}
const rank = { BASIC_ATTACK: 0, ABILITY: 1, EPIC: 2 } as const

const compareAction = (left: LegalAction, right: LegalAction): number => {
  const byKind = rank[left.kind] - rank[right.kind]

  if (byKind !== 0) return byKind

  const leftId = left.kind === 'ABILITY' ? left.abilityId : left.kind === 'EPIC' ? left.epicId : ''
  const rightId =
    right.kind === 'ABILITY' ? right.abilityId : right.kind === 'EPIC' ? right.epicId : ''
  const byId = compareText(leftId, rightId)

  if (byId !== 0) return byId
  return compareTarget(left.target, right.target)
}

const isExpectedCandidateRejection = (error: unknown): boolean =>
  error instanceof InvalidTargetError ||
  error instanceof SameTeamTargetError ||
  error instanceof InvalidHealTargetError ||
  error instanceof TargetUnavailableError ||
  error instanceof UnsupportedSkillEffectError ||
  error instanceof SkillOnCooldownError ||
  error instanceof InsufficientPowerForHealError ||
  error instanceof EpicOnCooldownError ||
  error instanceof UnsupportedEpicEffectError ||
  error instanceof EpicTargetRequiredError

/**
 * Enumerates candidates by asking BattleRoom's existing pure plan methods. Those methods
 * validate without resolving, mutating, persisting, or consuming RNG; this service does not
 * keep a second copy of Combat's legality rules.
 */
export class LegalActionGenerator {
  generate(room: BattleRoom): readonly LegalAction[] {
    const result = this.generateAvailable(room)

    if (result.length === 0) throw new NoLegalDecisionActionsError()
    return result
  }

  /**
   * Variante para el orquestador JcE: conserva todas las validaciones estructurales,
   * pero representa honestamente el caso valido de cero acciones como `[]`.
   */
  generateAvailable(room: BattleRoom): readonly LegalAction[] {
    if (room.status !== BattleRoomStatus.InBattle || room.battle === null) {
      throw new DecisionStateUnavailableError('la batalla no está en curso')
    }

    const battle = room.battle
    const actor = battle.currentEntry

    const candidates: LegalAction[] = []
    const actorKey = immutableKey(actor)
    const targets = battle.turnOrder
      .map(({ teamLabel, seat }) => immutableKey({ teamLabel, seat }))
      .sort(compareKey)
    const attacker = battle.combatantFor(actor)

    // A healer legitimately has no basic attack. Any other unsupported profile is a
    // structural/configuration error and must propagate instead of looking like an illegal target.
    if (attacker?.profile?.attack !== null && attacker?.profile?.attack !== undefined) {
      for (const target of targets) {
        try {
          room.planBasicAttackForActor(actorKey, target)

          candidates.push(Object.freeze({ kind: 'BASIC_ATTACK', target: combatantTarget(target) }))
        } catch (error) {
          if (!isExpectedCandidateRejection(error)) throw error
        }
      }
    }

    if (attacker?.profile !== null && attacker?.profile !== undefined) {
      const abilities = [...attacker.abilities].sort((left, right) =>
        compareText(left.abilityId, right.abilityId),
      )

      for (const ability of abilities) {
        const abilityTargets: readonly (CombatantKey | undefined)[] = [undefined, ...targets]

        for (const target of abilityTargets) {
          try {
            const plan = room.planSkillForActor(actorKey, ability.abilityId, target)

            // A skill that degrades to a basic attack is not a distinct strategic candidate.
            if (plan.kind !== 'degraded') {
              const strategicTarget =
                plan.kind === 'healingSkill' && plan.audience === 'ALLIED_GROUP'
                  ? alliedGroupTarget
                  : target === undefined
                    ? alliedGroupTarget
                    : combatantTarget(target)
              candidates.push(
                Object.freeze({
                  kind: 'ABILITY',
                  abilityId: ability.abilityId,
                  target: strategicTarget,
                }),
              )
            }
          } catch (error) {
            if (!isExpectedCandidateRejection(error)) throw error
          }
        }
      }

      const epicId = attacker.profile.epic?.epicProductId

      if (epicId !== undefined) {
        const epicTargets: (CombatantKey | undefined)[] = [undefined, ...targets]

        for (const target of epicTargets) {
          try {
            const plan = room.planEpicForActor(actorKey, target)

            const strategicTarget =
              plan.effectPlan.requiredAudience === 'ALLIED_GROUP'
                ? alliedGroupTarget
                : plan.effectPlan.requiredAudience === null
                  ? selfTarget
                  : plan.targetEntry === null
                    ? selfTarget
                    : combatantTarget(plan.targetEntry)
            candidates.push(Object.freeze({ kind: 'EPIC', epicId, target: strategicTarget }))
          } catch (error) {
            if (!isExpectedCandidateRejection(error)) throw error
          }
        }
      }
    }

    const unique = new Map<string, LegalAction>()

    for (const candidate of candidates) unique.set(legalActionIdentity(candidate), candidate)

    const result = [...unique.values()].sort(compareAction)

    return Object.freeze(result)
  }
}
