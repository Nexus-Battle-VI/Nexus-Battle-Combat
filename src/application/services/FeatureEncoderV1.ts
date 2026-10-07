import type {
  BattleDecisionState,
  DecisionAbility,
  DecisionCombatant,
  DecisionEffect,
  DecisionEpic,
} from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { CombatantKey } from '../../domain/entities/Combatant'
import type { CombatMagnitude } from '../../domain/entities/CombatProfile'
import {
  MissingReferencedEntityError,
  UnsupportedFeatureCategoryError,
} from '../../domain/errors/FeatureEncodingErrors'

/**
 * Contraparte TypeScript EXACTA de `feature-schema-v1`
 * (`ai/src/nexus_combat_ai/features/{schema,encoder}.py`, EN-036.2 #566,
 * EN-036.4 #568 §13-20, §82). Vive en Combat Node porque el RUNTIME de
 * inferencia es Node -- el training sigue siendo Python; la paridad entre
 * ambos encoders se demuestra con los MISMOS golden fixtures de #566
 * (`ai/tests/fixtures/golden-*.json`), nunca regenerados aqui (#568 §17).
 *
 * Reproduce, en el MISMO orden, las MISMAS 72 posiciones, las MISMAS
 * constantes de normalizacion y el MISMO vocabulario congelado que su
 * contraparte Python -- nunca una "version parecida" (#568 §15, §82). No
 * importa Python, no ejecuta Python, no lee `schema.py` en produccion
 * (#568 §14).
 *
 * Fail-closed (#568 §19, igual que Python): `schemaVersion` no soportada,
 * categoria fuera del vocabulario, Vida/Poder invalidos, o una referencia
 * (`abilityId`/`epicId`/combatiente objetivo) que no existe en `state`
 * lanzan un error explicito -- nunca un vector con ceros de relleno.
 */

export const FEATURE_SCHEMA_VERSION = 'feature-schema-v1'
export const DECISION_STATE_SCHEMA_VERSION_SUPPORTED = 1

const BATTLE_MODE_VOCAB = new Set(['PVP', 'PVE'])
const EFFECT_KIND_VOCAB = new Set([
  'STAT_MODIFIER',
  'DAMAGE',
  'REFLECT_DAMAGE',
  'IMMUNITY',
  'REVIVE',
])
const EFFECT_TARGET_VOCAB = new Set(['SELF', 'OPPONENT', 'ALLY', 'ALLIED_GROUP'])
const EFFECT_STATISTIC_VOCAB = new Set(['ATTACK', 'DAMAGE', 'DEFENSE', 'HEALING'])
const EFFECT_OPERATION_VOCAB = new Set(['INCREASE', 'DECREASE'])

// --- Constantes de normalizacion (identicas a schema.py) -------------------

export const ROUND_CAP = 50.0
export const TURNS_COMPLETED_CAP = 100.0
export const STAT_CAP = 100.0
export const MAGNITUDE_CAP = 50.0
export const LEVEL_MIN = 1
export const LEVEL_MAX = 8
export const COOLDOWNS_COUNT_CAP = 10.0
export const ABILITIES_COUNT_CAP = 10.0
export const ACTIVE_EFFECTS_COUNT_CAP = 10.0
export const DAMAGE_MEMORY_CAP = 50.0
export const POWER_COST_CAP = 20.0
export const CHARGE_OR_COOLDOWN_CAP = 20.0
export const EFFECT_COUNT_CAP = 10.0
export const TEAM_CAP = 5.0

// --- Orden canonico de las 72 posiciones (identico a schema.py) ------------

const STATE_FEATURE_NAMES = [
  'state.mode_pvp',
  'state.mode_pve',
  'state.round_norm',
  'state.turns_completed_norm',
] as const

const ACTOR_FEATURE_NAMES = [
  'actor.health_ratio',
  'actor.power_present',
  'actor.power_ratio',
  'actor.attack_present',
  'actor.attack_norm',
  'actor.defense_norm',
  'actor.damage_present',
  'actor.damage_mode_fixed',
  'actor.damage_mode_percentage',
  'actor.damage_mode_dice',
  'actor.damage_value_norm',
  'actor.level_norm',
  'actor.cooldowns_count_norm',
  'actor.abilities_count_norm',
  'actor.epic_present',
  'actor.epic_power_cost_norm',
  'actor.epic_cooldown_ratio',
  'actor.active_effects_count_norm',
  'actor.damage_memory_present',
  'actor.damage_memory_amount_norm',
] as const

const groupFeatureNames = (prefix: 'allies' | 'enemies'): readonly string[] => [
  `${prefix}.count_norm`,
  `${prefix}.alive_count_norm`,
  `${prefix}.health_ratio_mean`,
  `${prefix}.health_ratio_min`,
  `${prefix}.power_presence_ratio`,
  `${prefix}.power_ratio_mean`,
  `${prefix}.attack_norm_mean`,
  `${prefix}.defense_norm_mean`,
  `${prefix}.active_effects_count_mean_norm`,
]

const CANDIDATE_FEATURE_NAMES = [
  'candidate.kind_basic_attack',
  'candidate.kind_ability',
  'candidate.kind_epic',
  'candidate.target_scope_combatant',
  'candidate.target_scope_self',
  'candidate.target_scope_allied_group',
  'candidate.target_relation_self',
  'candidate.target_relation_ally',
  'candidate.target_relation_enemy',
  'candidate.target_is_group',
  'candidate.target_health_ratio',
  'candidate.target_power_present',
  'candidate.target_power_ratio',
  'candidate.target_is_alive',
  'candidate.has_power_cost',
  'candidate.power_cost_mode_fixed',
  'candidate.power_cost_mode_all_available',
  'candidate.power_cost_norm',
  'candidate.charge_or_cooldown_total_norm',
  'candidate.cooldown_ratio',
  'candidate.effect_count_norm',
  'candidate.effect_has_healing',
  'candidate.effect_has_damage',
  'candidate.effect_has_buff_self',
  'candidate.effect_has_debuff_opponent',
  'candidate.effect_has_immunity',
  'candidate.primary_effect_mode_fixed',
  'candidate.primary_effect_mode_percentage',
  'candidate.primary_effect_mode_dice',
  'candidate.primary_effect_value_norm',
] as const

export const FEATURE_NAMES: readonly string[] = [
  ...STATE_FEATURE_NAMES,
  ...ACTOR_FEATURE_NAMES,
  ...groupFeatureNames('allies'),
  ...groupFeatureNames('enemies'),
  ...CANDIDATE_FEATURE_NAMES,
]

/** Derivado de `FEATURE_NAMES.length`, nunca el literal `72` repetido (#567/#568). */
export const FEATURE_DIMENSION: number = FEATURE_NAMES.length

// --- Helpers de normalizacion ------------------------------------------------

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

const saturatingNorm = (value: number, cap: number): number => clamp01(value / cap)

const checkVocab = (value: string | undefined, vocab: ReadonlySet<string>, label: string): void => {
  if (value !== undefined && !vocab.has(value)) {
    throw new UnsupportedFeatureCategoryError(`${label} = "${value}"`)
  }
}

const magnitudeExpectedValue = (magnitude: CombatMagnitude): number => {
  switch (magnitude.mode) {
    case 'FIXED':
      return magnitude.amount
    case 'PERCENTAGE':
      return magnitude.basisPoints / 100.0
    case 'DICE':
      return (magnitude.count * (magnitude.sides + 1)) / 2.0
  }
}

type MagnitudeOnehot = readonly [fixed: number, percentage: number, dice: number, valueNorm: number]

const magnitudeOnehotValue = (magnitude: CombatMagnitude | null | undefined): MagnitudeOnehot => {
  if (magnitude === null || magnitude === undefined) return [0, 0, 0, 0]
  const fixed = magnitude.mode === 'FIXED' ? 1 : 0
  const percentage = magnitude.mode === 'PERCENTAGE' ? 1 : 0
  const dice = magnitude.mode === 'DICE' ? 1 : 0
  const valueNorm = saturatingNorm(magnitudeExpectedValue(magnitude), MAGNITUDE_CAP)
  return [fixed, percentage, dice, valueNorm]
}

const checkEffectVocab = (effect: DecisionEffect, path: string): void => {
  checkVocab(effect.kind, EFFECT_KIND_VOCAB, `${path}.kind`)
  checkVocab(effect.target, EFFECT_TARGET_VOCAB, `${path}.target`)
  checkVocab(effect.statistic, EFFECT_STATISTIC_VOCAB, `${path}.statistic`)
  checkVocab(effect.operation, EFFECT_OPERATION_VOCAB, `${path}.operation`)
}

interface GroupAggregate {
  readonly countNorm: number
  readonly aliveCountNorm: number
  readonly healthRatioMean: number
  readonly healthRatioMin: number
  readonly powerPresenceRatio: number
  readonly powerRatioMean: number
  readonly attackNormMean: number
  readonly defenseNormMean: number
  readonly activeEffectsCountMeanNorm: number
}

const groupAggregateAsList = (aggregate: GroupAggregate): number[] => [
  aggregate.countNorm,
  aggregate.aliveCountNorm,
  aggregate.healthRatioMean,
  aggregate.healthRatioMin,
  aggregate.powerPresenceRatio,
  aggregate.powerRatioMean,
  aggregate.attackNormMean,
  aggregate.defenseNormMean,
  aggregate.activeEffectsCountMeanNorm,
]

const healthRatio = (combatant: DecisionCombatant, path: string): number => {
  if (combatant.health === null) {
    throw new MissingReferencedEntityError(
      `${path}: el combatiente no tiene Vida valida (health=null).`,
    )
  }
  const { current, max } = combatant.health
  if (max <= 0) {
    throw new MissingReferencedEntityError(`${path}: maxHealth invalido (${String(max)}).`)
  }
  return Math.max(0, Math.min(1, current / max))
}

const powerPresenceRatio = (combatant: DecisionCombatant): readonly [boolean, number] => {
  if (combatant.power === null) return [false, 0]
  const { current, max } = combatant.power
  if (max <= 0) return [false, 0]
  return [true, Math.max(0, Math.min(1, current / max))]
}

const attackPresenceNorm = (combatant: DecisionCombatant): readonly [boolean, number] => {
  if (combatant.attack === null) return [false, 0]
  return [true, saturatingNorm(combatant.attack, STAT_CAP)]
}

const defenseNorm = (combatant: DecisionCombatant): number =>
  combatant.defense === null ? 0 : saturatingNorm(combatant.defense, STAT_CAP)

const groupAggregate = (members: readonly DecisionCombatant[], path: string): GroupAggregate => {
  const count = members.length
  if (count === 0) {
    return {
      countNorm: 0,
      aliveCountNorm: 0,
      healthRatioMean: 1,
      healthRatioMin: 1,
      powerPresenceRatio: 0,
      powerRatioMean: 0,
      attackNormMean: 0,
      defenseNormMean: 0,
      activeEffectsCountMeanNorm: 0,
    }
  }

  const healthRatios = members.map((member, i) => healthRatio(member, `${path}[${String(i)}]`))
  const aliveCount = healthRatios.filter((ratio) => ratio > 0).length

  const powerFlagsRatios = members.map((member) => powerPresenceRatio(member))
  const presentPowerRatios = powerFlagsRatios
    .filter(([present]) => present)
    .map(([, ratio]) => ratio)
  const powerRatioMean =
    presentPowerRatios.length > 0
      ? presentPowerRatios.reduce((sum, value) => sum + value, 0) / presentPowerRatios.length
      : 0

  const attackFlagsNorms = members.map((member) => attackPresenceNorm(member))
  const presentAttackNorms = attackFlagsNorms.filter(([present]) => present).map(([, norm]) => norm)
  const attackNormMean =
    presentAttackNorms.length > 0
      ? presentAttackNorms.reduce((sum, value) => sum + value, 0) / presentAttackNorms.length
      : 0

  const defenseNorms = members.map((member) => defenseNorm(member))
  const activeEffectsNorms = members.map((member) =>
    saturatingNorm(member.activeEffects.length, ACTIVE_EFFECTS_COUNT_CAP),
  )

  return {
    countNorm: saturatingNorm(count, TEAM_CAP),
    aliveCountNorm: saturatingNorm(aliveCount, TEAM_CAP),
    healthRatioMean: healthRatios.reduce((sum, value) => sum + value, 0) / count,
    healthRatioMin: Math.min(...healthRatios),
    powerPresenceRatio: powerFlagsRatios.filter(([present]) => present).length / count,
    powerRatioMean,
    attackNormMean,
    defenseNormMean: defenseNorms.reduce((sum, value) => sum + value, 0) / count,
    activeEffectsCountMeanNorm: activeEffectsNorms.reduce((sum, value) => sum + value, 0) / count,
  }
}

const sameCombatant = (left: CombatantKey, right: CombatantKey): boolean =>
  left.teamLabel === right.teamLabel && left.seat === right.seat

const findCombatant = (state: BattleDecisionState, key: CombatantKey): DecisionCombatant | null => {
  if (sameCombatant(state.actor.identity, key)) return state.actor
  for (const ally of state.allies) {
    if (sameCombatant(ally.identity, key)) return ally
  }
  for (const enemy of state.enemies) {
    if (sameCombatant(enemy.identity, key)) return enemy
  }
  return null
}

type EffectsSummary = readonly [
  hasHealing: number,
  hasDamage: number,
  hasBuffSelf: number,
  hasDebuffOpponent: number,
  hasImmunity: number,
]

const effectsSummary = (effects: readonly DecisionEffect[], path: string): EffectsSummary => {
  let hasHealing = false
  let hasDamage = false
  let hasBuffSelf = false
  let hasDebuffOpponent = false
  let hasImmunity = false

  // `for` simple, no `.forEach` (#568): las reasignaciones dentro de un
  // callback anidado no refinan el tipo de las `let` externas para el
  // analisis de flujo de TypeScript/ESLint en el punto de lectura mas
  // abajo -- con un `for` en el mismo scope si lo hacen.
  for (let i = 0; i < effects.length; i += 1) {
    const effect = effects[i]
    if (effect === undefined) continue
    checkEffectVocab(effect, `${path}[${String(i)}]`)
    if (effect.statistic === 'HEALING') hasHealing = true
    if (effect.kind === 'DAMAGE' || effect.statistic === 'DAMAGE') hasDamage = true
    if (
      effect.target === 'SELF' &&
      effect.operation === 'INCREASE' &&
      effect.statistic !== 'HEALING'
    ) {
      hasBuffSelf = true
    }
    if (effect.target === 'OPPONENT' && effect.operation === 'DECREASE') hasDebuffOpponent = true
    if (effect.kind === 'IMMUNITY') hasImmunity = true
  }

  return [
    hasHealing ? 1 : 0,
    hasDamage ? 1 : 0,
    hasBuffSelf ? 1 : 0,
    hasDebuffOpponent ? 1 : 0,
    hasImmunity ? 1 : 0,
  ]
}

const resolveAbility = (actor: DecisionCombatant, abilityId: string): DecisionAbility => {
  const found = actor.abilities.find((ability) => ability.abilityId === abilityId)
  if (found === undefined) {
    throw new MissingReferencedEntityError(
      `candidate.abilityId = "${abilityId}" no existe en state.actor.abilities.`,
    )
  }
  return found
}

const resolveEpic = (actor: DecisionCombatant, epicId: string): DecisionEpic => {
  if (actor.epic === null) {
    throw new MissingReferencedEntityError(
      `candidate.epicId = "${epicId}" pero state.actor.epic es null.`,
    )
  }
  if (actor.epic.epicId !== epicId) {
    throw new MissingReferencedEntityError(
      `candidate.epicId = "${epicId}" no coincide con state.actor.epic.epicId ` +
        `("${actor.epic.epicId}").`,
    )
  }
  return actor.epic
}

type TargetResolution = readonly [
  relationSelf: number,
  relationAlly: number,
  relationEnemy: number,
  healthRatio: number,
  powerPresent: number,
  powerRatio: number,
]

/** Espejo de `FeatureEncoder.encode(state, candidate) -> np.ndarray[float32]` (Python). */
export class FeatureEncoderV1 {
  encode(state: BattleDecisionState, candidate: LegalAction): Float32Array {
    // `as number` en ambos lados: hoy los dos son el literal `1`, pero esto
    // es una guarda de compatibilidad futura (#568 §127: un `feature-schema-v2`
    // debe poder rechazar un `schemaVersion` distinto), no codigo muerto.
    if ((state.schemaVersion as number) !== (DECISION_STATE_SCHEMA_VERSION_SUPPORTED as number)) {
      throw new UnsupportedFeatureCategoryError(
        `BattleDecisionState.schemaVersion = ${String(state.schemaVersion)} no soportado por ` +
          `feature-schema-v1 (solo ${String(DECISION_STATE_SCHEMA_VERSION_SUPPORTED)})`,
      )
    }
    checkVocab(state.context.mode, BATTLE_MODE_VOCAB, 'state.context.mode')

    const alliesAggregate = groupAggregate(state.allies, 'state.allies')
    const enemiesAggregate = groupAggregate(state.enemies, 'state.enemies')

    const values: number[] = [
      ...this.stateFeatures(state),
      ...this.actorFeatures(state.actor),
      ...groupAggregateAsList(alliesAggregate),
      ...groupAggregateAsList(enemiesAggregate),
      ...this.candidateFeatures(state, candidate, alliesAggregate),
    ]

    if (values.length !== FEATURE_DIMENSION) {
      throw new UnsupportedFeatureCategoryError(
        `feature-schema-v1 produjo ${String(values.length)} valores, se esperaban ` +
          String(FEATURE_DIMENSION),
      )
    }

    const vector = new Float32Array(values)
    for (const value of vector) {
      if (!Number.isFinite(value)) {
        throw new UnsupportedFeatureCategoryError('El vector de features contiene NaN/Inf')
      }
    }
    return vector
  }

  private stateFeatures(state: BattleDecisionState): number[] {
    const mode = state.context.mode
    return [
      mode === 'PVP' ? 1 : 0,
      mode === 'PVE' ? 1 : 0,
      saturatingNorm(state.context.round, ROUND_CAP),
      saturatingNorm(state.context.turnsCompleted, TURNS_COMPLETED_CAP),
    ]
  }

  private actorFeatures(actor: DecisionCombatant): number[] {
    const hr = healthRatio(actor, 'state.actor')
    const [powerPresent, powerRatio] = powerPresenceRatio(actor)
    const [attackPresent, attackNorm] = attackPresenceNorm(actor)
    const defNorm = defenseNorm(actor)
    const damagePresent = actor.damage !== null
    const [damageFixed, damagePct, damageDice, damageValue] = magnitudeOnehotValue(actor.damage)
    const level = actor.level ?? LEVEL_MIN
    const levelNorm = (level - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN)
    const cooldownsNorm = saturatingNorm(actor.cooldowns.length, COOLDOWNS_COUNT_CAP)
    const abilitiesNorm = saturatingNorm(actor.abilities.length, ABILITIES_COUNT_CAP)
    const epicPresent = actor.epic !== null
    const epicCostNorm =
      actor.epic !== null ? saturatingNorm(actor.epic.powerCost, POWER_COST_CAP) : 0
    const epicCooldownRatio =
      actor.epic !== null && actor.epic.cooldownTurns > 0
        ? actor.epic.cooldownRemaining / actor.epic.cooldownTurns
        : 0
    const activeEffectsNorm = saturatingNorm(actor.activeEffects.length, ACTIVE_EFFECTS_COUNT_CAP)
    const damageMemoryPresent = actor.damageMemory !== null
    const damageMemoryNorm =
      actor.damageMemory !== null ? saturatingNorm(actor.damageMemory.amount, DAMAGE_MEMORY_CAP) : 0

    return [
      hr,
      powerPresent ? 1 : 0,
      powerRatio,
      attackPresent ? 1 : 0,
      attackNorm,
      defNorm,
      damagePresent ? 1 : 0,
      damageFixed,
      damagePct,
      damageDice,
      damageValue,
      levelNorm,
      cooldownsNorm,
      abilitiesNorm,
      epicPresent ? 1 : 0,
      epicCostNorm,
      epicCooldownRatio,
      activeEffectsNorm,
      damageMemoryPresent ? 1 : 0,
      damageMemoryNorm,
    ]
  }

  private candidateFeatures(
    state: BattleDecisionState,
    candidate: LegalAction,
    alliesAggregate: GroupAggregate,
  ): number[] {
    const kindBasic = candidate.kind === 'BASIC_ATTACK' ? 1 : 0
    const kindAbility = candidate.kind === 'ABILITY' ? 1 : 0
    const kindEpic = candidate.kind === 'EPIC' ? 1 : 0

    const scope = candidate.target.scope
    const scopeCombatant = scope === 'COMBATANT' ? 1 : 0
    const scopeSelf = scope === 'SELF' ? 1 : 0
    const scopeGroup = scope === 'ALLIED_GROUP' ? 1 : 0

    const [
      relationSelf,
      relationAlly,
      relationEnemy,
      targetHealthRatio,
      targetPowerPresent,
      targetPowerRatio,
    ] = this.resolveTarget(state, candidate, alliesAggregate)

    const targetIsGroup = scopeGroup
    const targetIsAlive = targetHealthRatio > 0 ? 1 : 0

    const hasPowerCost = candidate.kind === 'ABILITY' || candidate.kind === 'EPIC'
    let powerCostModeFixed = 0
    let powerCostModeAll = 0
    let powerCostNorm = 0
    let chargeOrCooldownNorm = 0
    let cooldownRatio = 0
    let effectCountNorm = 0
    let effectHasHealing = 0
    let effectHasDamage = 0
    let effectHasBuffSelf = 0
    let effectHasDebuffOpponent = 0
    let effectHasImmunity = 0
    let primaryFixed = 0
    let primaryPct = 0
    let primaryDice = 0
    let primaryValue = 0

    if (candidate.kind === 'ABILITY') {
      const ability = resolveAbility(state.actor, candidate.abilityId)
      powerCostModeFixed = ability.powerCost.mode === 'FIXED' ? 1 : 0
      powerCostModeAll = ability.powerCost.mode === 'ALL_AVAILABLE' ? 1 : 0
      if (ability.powerCost.mode === 'FIXED') {
        powerCostNorm = saturatingNorm(ability.powerCost.amount, POWER_COST_CAP)
      } else {
        const [, actorPowerRatio] = powerPresenceRatio(state.actor)
        powerCostNorm = actorPowerRatio
      }
      chargeOrCooldownNorm = saturatingNorm(ability.chargeTurns, CHARGE_OR_COOLDOWN_CAP)
      const matching = state.actor.cooldowns.find((c) => c.abilityId === ability.abilityId)
      const remaining = matching?.remainingOwnTurns ?? 0
      cooldownRatio = ability.chargeTurns > 0 ? remaining / ability.chargeTurns : 0
      effectCountNorm = saturatingNorm(ability.effects.length, EFFECT_COUNT_CAP)
      ;[
        effectHasHealing,
        effectHasDamage,
        effectHasBuffSelf,
        effectHasDebuffOpponent,
        effectHasImmunity,
      ] = effectsSummary(ability.effects, `actor.abilities["${ability.abilityId}"].effects`)
      const primary = ability.effects[0]?.magnitude ?? null
      ;[primaryFixed, primaryPct, primaryDice, primaryValue] = magnitudeOnehotValue(primary)
    } else if (candidate.kind === 'EPIC') {
      const epic = resolveEpic(state.actor, candidate.epicId)
      powerCostModeFixed = 1
      powerCostNorm = saturatingNorm(epic.powerCost, POWER_COST_CAP)
      chargeOrCooldownNorm = saturatingNorm(epic.cooldownTurns, CHARGE_OR_COOLDOWN_CAP)
      cooldownRatio = epic.cooldownTurns > 0 ? epic.cooldownRemaining / epic.cooldownTurns : 0
      effectCountNorm = saturatingNorm(epic.effects.length, EFFECT_COUNT_CAP)
      ;[
        effectHasHealing,
        effectHasDamage,
        effectHasBuffSelf,
        effectHasDebuffOpponent,
        effectHasImmunity,
      ] = effectsSummary(epic.effects, 'actor.epic.effects')
      const primary = epic.effects[0]?.magnitude ?? null
      ;[primaryFixed, primaryPct, primaryDice, primaryValue] = magnitudeOnehotValue(primary)
    }

    return [
      kindBasic,
      kindAbility,
      kindEpic,
      scopeCombatant,
      scopeSelf,
      scopeGroup,
      relationSelf,
      relationAlly,
      relationEnemy,
      targetIsGroup,
      targetHealthRatio,
      targetPowerPresent,
      targetPowerRatio,
      targetIsAlive,
      hasPowerCost ? 1 : 0,
      powerCostModeFixed,
      powerCostModeAll,
      powerCostNorm,
      chargeOrCooldownNorm,
      cooldownRatio,
      effectCountNorm,
      effectHasHealing,
      effectHasDamage,
      effectHasBuffSelf,
      effectHasDebuffOpponent,
      effectHasImmunity,
      primaryFixed,
      primaryPct,
      primaryDice,
      primaryValue,
    ]
  }

  private resolveTarget(
    state: BattleDecisionState,
    candidate: LegalAction,
    alliesAggregate: GroupAggregate,
  ): TargetResolution {
    const target = candidate.target

    if (target.scope === 'SELF') {
      const hr = healthRatio(state.actor, 'state.actor')
      const [powerPresent, powerRatio] = powerPresenceRatio(state.actor)
      return [1, 0, 0, hr, powerPresent ? 1 : 0, powerRatio]
    }

    if (target.scope === 'ALLIED_GROUP') {
      return [
        0,
        1,
        0,
        alliesAggregate.healthRatioMean,
        alliesAggregate.powerPresenceRatio > 0 ? 1 : 0,
        alliesAggregate.powerRatioMean,
      ]
    }

    const targetKey = target.combatant
    if (sameCombatant(targetKey, state.actor.identity)) {
      const hr = healthRatio(state.actor, 'state.actor')
      const [powerPresent, powerRatio] = powerPresenceRatio(state.actor)
      return [1, 0, 0, hr, powerPresent ? 1 : 0, powerRatio]
    }

    const resolved = findCombatant(state, targetKey)
    if (resolved === null) {
      throw new MissingReferencedEntityError(
        `candidate.target.combatant = "${targetKey.teamLabel}#${String(targetKey.seat)}" no existe ` +
          'en el state (ni actor, ni allies, ni enemies).',
      )
    }
    const hr = healthRatio(resolved, `target["${targetKey.teamLabel}#${String(targetKey.seat)}"]`)
    const [powerPresent, powerRatio] = powerPresenceRatio(resolved)
    const isAlly = resolved.identity.teamLabel === state.actor.identity.teamLabel
    return isAlly
      ? [0, 1, 0, hr, powerPresent ? 1 : 0, powerRatio]
      : [0, 0, 1, hr, powerPresent ? 1 : 0, powerRatio]
  }
}
