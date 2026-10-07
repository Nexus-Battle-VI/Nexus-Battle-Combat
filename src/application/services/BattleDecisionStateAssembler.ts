import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type {
  DecisionActiveEffect,
  DecisionCombatant,
  DecisionEffect,
} from '../../domain/decision/BattleDecisionState'
import type { CombatantKey } from '../../domain/entities/Combatant'
import type { CombatAbilityEffect } from '../../domain/entities/CombatProfile'
import { DecisionStateUnavailableError } from '../../domain/errors/DecisionContractErrors'
import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const sameKey = (left: CombatantKey, right: CombatantKey): boolean =>
  left.teamLabel === right.teamLabel && left.seat === right.seat

const decisionEffect = (effect: CombatAbilityEffect): DecisionEffect =>
  Object.freeze({
    kind: effect.kind,
    target: effect.target,
    ...(effect.statistic === undefined ? {} : { statistic: effect.statistic }),
    ...(effect.operation === undefined ? {} : { operation: effect.operation }),
    ...(effect.magnitude === undefined
      ? {}
      : { magnitude: Object.freeze({ ...effect.magnitude }) }),
    ...(effect.durationTurns === undefined ? {} : { durationTurns: effect.durationTurns }),
    hasActivationCondition: effect.hasActivationCondition,
    ...(effect.immunityCode === undefined ? {} : { immunityCode: effect.immunityCode }),
  })

const activeEffectIdentity = (effect: DecisionActiveEffect): string =>
  effect.kind === 'STAT'
    ? [
        effect.sourceAbilityId,
        effect.sourceCombatant.teamLabel,
        String(effect.sourceCombatant.seat),
        effect.kind,
        effect.statistic,
        effect.operation,
        String(effect.amount),
        String(effect.remainingOwnTurns),
      ].join('|')
    : [
        effect.sourceAbilityId,
        effect.sourceCombatant.teamLabel,
        String(effect.sourceCombatant.seat),
        effect.kind,
        effect.immunityCode,
        String(effect.remainingOwnTurns),
      ].join('|')

const decisionView = (
  room: BattleRoom,
  entry: NonNullable<BattleRoom['battle']>['currentEntry'],
): DecisionCombatant => {
  const combatant = room.battle?.combatantFor(entry)

  if (combatant === undefined) {
    throw new DecisionStateUnavailableError('falta el combatiente en el snapshot de batalla')
  }

  const profile = combatant.profile
  const cooldowns = Object.entries(combatant.cooldowns)
    .filter(([, remaining]) => remaining > 0)
    .sort(([left], [right]) => compareText(left, right))
    .map(([abilityId, remainingOwnTurns]) => Object.freeze({ abilityId, remainingOwnTurns }))
  const abilities = (profile?.abilities ?? [])
    .map((ability) =>
      Object.freeze({
        abilityId: ability.abilityId,
        powerCost: Object.freeze({ ...ability.powerCost }),
        chargeTurns: ability.chargeTurns,
        effects: Object.freeze(ability.effects.map(decisionEffect)),
      }),
    )
    .sort((left, right) => compareText(left.abilityId, right.abilityId))
  const epic =
    profile?.epic === undefined
      ? null
      : Object.freeze({
          epicId: profile.epic.epicProductId,
          powerCost: profile.epic.powerCost,
          cooldownTurns: profile.epic.cooldownTurns,
          cooldownRemaining: combatant.cooldownOf(profile.epic.epicProductId),
          effects: Object.freeze(profile.epic.executableEffects.map(decisionEffect)),
        })
  const activeEffects: DecisionActiveEffect[] = combatant.activeSkillEffects
    .map((effect) =>
      'statistic' in effect
        ? Object.freeze({
            kind: 'STAT' as const,
            sourceAbilityId: effect.sourceAbilityId,
            sourceCombatant: Object.freeze({ ...effect.sourceCombatant }),
            statistic: effect.statistic,
            operation: effect.operation,
            amount: effect.amount,
            remainingOwnTurns: effect.remainingOwnTurns,
          })
        : Object.freeze({
            kind: 'IMMUNITY' as const,
            sourceAbilityId: effect.sourceAbilityId,
            sourceCombatant: Object.freeze({ ...effect.sourceCombatant }),
            immunityCode: effect.immunityCode,
            remainingOwnTurns: effect.remainingOwnTurns,
          }),
    )
    .sort((left, right) => compareText(activeEffectIdentity(left), activeEffectIdentity(right)))
  const damageMemory =
    combatant.damageMemory === null ? null : Object.freeze({ ...combatant.damageMemory })

  return Object.freeze({
    identity: Object.freeze({ teamLabel: entry.teamLabel, seat: entry.seat }),
    kind: entry.kind,
    heroSubtype: entry.heroSubtype,
    health:
      profile === null || combatant.currentHealth === null
        ? null
        : Object.freeze({ current: combatant.currentHealth, max: profile.maxHealth }),
    power:
      profile?.maxPower === undefined || combatant.currentPower === null
        ? null
        : Object.freeze({ current: combatant.currentPower, max: profile.maxPower }),
    attack: profile?.attack ?? null,
    defense: profile?.defense ?? null,
    damage:
      profile?.damage === undefined || profile.damage === null
        ? null
        : Object.freeze({ ...profile.damage }),
    level: profile === null ? null : (profile.level ?? 1),
    cooldowns: Object.freeze(cooldowns),
    abilities: Object.freeze(abilities),
    epic,
    activeEffects: Object.freeze(activeEffects),
    damageMemory,
  })
}

/** Proyecta el estado ya congelado por Combat, sin persistencia, red, PII ni estado del RNG. */
export class BattleDecisionStateAssembler {
  assemble(room: BattleRoom, requestedActor?: CombatantKey): BattleDecisionState {
    if (room.status !== BattleRoomStatus.InBattle || room.battle === null) {
      throw new DecisionStateUnavailableError('la batalla no está en curso')
    }

    const battle = room.battle
    const actorEntry = battle.currentEntry

    if (requestedActor !== undefined && !sameKey(requestedActor, actorEntry)) {
      throw new DecisionStateUnavailableError('el actor solicitado no corresponde al turno vigente')
    }

    const actor = decisionView(room, actorEntry)
    const allies = battle.turnOrder
      .filter(
        (entry) =>
          entry.teamLabel === actorEntry.teamLabel &&
          !(entry.teamLabel === actorEntry.teamLabel && entry.seat === actorEntry.seat),
      )
      .map((entry) => decisionView(room, entry))
      .sort((left, right) => left.identity.seat - right.identity.seat)
    const enemies = battle.turnOrder
      .filter((entry) => entry.teamLabel !== actorEntry.teamLabel)
      .map((entry) => decisionView(room, entry))
      .sort(
        (left, right) =>
          compareText(left.identity.teamLabel, right.identity.teamLabel) ||
          left.identity.seat - right.identity.seat,
      )

    return Object.freeze({
      schemaVersion: 1 as const,
      context: Object.freeze({
        battleId: room.id,
        mode: room.mode,
        round: battle.round,
        turnsCompleted: battle.turnsCompleted,
      }),
      actor,
      allies: Object.freeze(allies),
      enemies: Object.freeze(enemies),
    })
  }
}
