import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { CombatantKey } from '../../domain/entities/Combatant'
import { DomainError } from '../../domain/errors/DomainError'
import {
  DecisionStateUnavailableError,
  NoLegalDecisionActionsError,
} from '../../domain/errors/DecisionContractErrors'
import { ParticipantKind } from '../../domain/entities/Participant'
import type { LegalAction } from '../../domain/decision/LegalAction'
import { legalActionIdentity } from '../../domain/decision/ActionIdentity'
import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0
const compareKey = (left: CombatantKey, right: CombatantKey): number =>
  compareText(left.teamLabel, right.teamLabel) || left.seat - right.seat
const compareNullableKey = (left: CombatantKey | null, right: CombatantKey | null): number => {
  if (left === null) return right === null ? 0 : -1
  if (right === null) return 1
  return compareKey(left, right)
}
const immutableKey = (key: CombatantKey): CombatantKey =>
  Object.freeze({ teamLabel: key.teamLabel, seat: key.seat })
const rank = { BASIC_ATTACK: 0, ABILITY: 1, EPIC: 2 } as const

const compareAction = (left: LegalAction, right: LegalAction): number => {
  const byKind = rank[left.kind] - rank[right.kind]

  if (byKind !== 0) return byKind

  const leftId = left.kind === 'ABILITY' ? left.abilityId : left.kind === 'EPIC' ? left.epicId : ''
  const rightId =
    right.kind === 'ABILITY' ? right.abilityId : right.kind === 'EPIC' ? right.epicId : ''
  const byId = compareText(leftId, rightId)

  if (byId !== 0) return byId
  return compareNullableKey(left.target, right.target)
}

/**
 * Enumerates candidates by asking BattleRoom's existing pure plan methods. Those methods
 * validate without resolving, mutating, persisting, or consuming RNG; this service does not
 * keep a second copy of Combat's legality rules.
 */
export class LegalActionGenerator {
  generate(room: BattleRoom): readonly LegalAction[] {
    if (room.status !== BattleRoomStatus.InBattle || room.battle === null) {
      throw new DecisionStateUnavailableError('la batalla no está en curso')
    }

    const battle = room.battle
    const actor = battle.currentEntry

    if (actor.kind !== ParticipantKind.Human || actor.playerId === null) {
      throw new DecisionStateUnavailableError(
        'Combat aún no tiene un perfil ejecutable para participantes AI; su turno automático corresponde a HU-93',
      )
    }

    const candidates: LegalAction[] = []
    const targets = battle.turnOrder
      .map(({ teamLabel, seat }) => immutableKey({ teamLabel, seat }))
      .sort(compareKey)
    const probeId = (stem: string): string => {
      let suffix = 0
      let commandId = `decision-probe-${stem}`

      while (room.handledCommands.some((command) => command.commandId === commandId)) {
        suffix += 1
        commandId = `decision-probe-${stem}-${String(suffix)}`
      }

      return commandId
    }

    for (const [index, target] of targets.entries()) {
      try {
        const plan = room.planBasicAttack(actor.playerId, probeId(`basic-${String(index)}`), target)

        if (plan.kind === 'ready') candidates.push(Object.freeze({ kind: 'BASIC_ATTACK', target }))
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
      }
    }

    const attacker = battle.combatantFor(actor)

    if (attacker?.profile !== null && attacker?.profile !== undefined) {
      const abilities = [...attacker.abilities].sort((left, right) =>
        compareText(left.abilityId, right.abilityId),
      )

      for (const [abilityIndex, ability] of abilities.entries()) {
        // ALLIED_GROUP consumes a target-shaped command field but Combat resolves the group
        // itself. Use the actor as a deterministic placeholder so it remains one candidate.
        const abilityTargets = ability.effects.some((effect) => effect.target === 'ALLIED_GROUP')
          ? [immutableKey({ teamLabel: actor.teamLabel, seat: actor.seat })]
          : targets

        for (const [targetIndex, target] of abilityTargets.entries()) {
          try {
            const plan = room.planSkill(
              actor.playerId,
              probeId(`ability-${String(abilityIndex)}-${String(targetIndex)}`),
              ability.abilityId,
              target,
            )

            // A skill that degrades to a basic attack is not a distinct strategic candidate.
            if (plan.kind !== 'replay' && plan.kind !== 'degraded') {
              candidates.push(
                Object.freeze({ kind: 'ABILITY', abilityId: ability.abilityId, target }),
              )
            }
          } catch (error) {
            if (!(error instanceof DomainError)) throw error
          }
        }
      }

      const epicId = attacker.profile.epic?.epicProductId

      if (epicId !== undefined) {
        const epicTargets: (CombatantKey | undefined)[] = [undefined, ...targets]

        for (const [targetIndex, target] of epicTargets.entries()) {
          try {
            const plan = room.planEpic(
              actor.playerId,
              probeId(`epic-${String(targetIndex)}`),
              target,
            )

            if (plan.kind === 'epic') {
              const resolvedTarget =
                plan.effectPlan.requiredAudience === 'ALLY' ||
                plan.effectPlan.requiredAudience === 'OPPONENT'
                  ? plan.target === null
                    ? null
                    : immutableKey({
                        teamLabel: plan.target.teamLabel,
                        seat: plan.target.seat,
                      })
                  : null
              candidates.push(Object.freeze({ kind: 'EPIC', epicId, target: resolvedTarget }))
            }
          } catch (error) {
            if (!(error instanceof DomainError)) throw error
          }
        }
      }
    }

    const unique = new Map<string, LegalAction>()

    for (const candidate of candidates) unique.set(legalActionIdentity(candidate), candidate)

    const result = [...unique.values()].sort(compareAction)

    if (result.length === 0) throw new NoLegalDecisionActionsError()
    return Object.freeze(result)
  }
}
