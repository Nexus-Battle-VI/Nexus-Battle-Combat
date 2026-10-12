import type { CombatAbility } from '../../domain/entities/CombatProfile'
import type { DecisionActionTarget, LegalAction } from '../../domain/decision/LegalAction'
import { legalActionIdentity } from '../../domain/decision/ActionIdentity'
import { evaluateMissionAbility } from '../../domain/policies/MissionAbilityPolicy'
import type { CombatDecisionSelection } from '../../domain/decision/CombatDecisionEvent'

export type RotationPriority = 'HIGH' | 'MEDIUM' | 'LOW'

/**
 * Por que una rotacion no fue viable en un turno (HU-71, P-R7), mas la
 * elegibilidad de salud nueva (ADR-023). `UNKNOWN_ABILITY`/`UNSUPPORTED_EFFECT`
 * vienen de Combat (la habilidad no esta en el perfil o su efecto no tiene
 * semantica de mision); `ON_COOLDOWN`/`NOT_ENOUGH_POWER` del diseño original;
 * `HEALTH_NOT_ELIGIBLE` es nueva: una curacion no es candidata cuando la
 * salud ya esta por encima del umbral.
 */
export type RotationSkipReason =
  | 'UNKNOWN_ABILITY'
  | 'UNSUPPORTED_EFFECT'
  | 'ON_COOLDOWN'
  | 'NOT_ENOUGH_POWER'
  | 'HEALTH_NOT_ELIGIBLE'
  | 'OFFENSIVE_ACTION_NOT_AVAILABLE'

export interface MissionRotationStep {
  readonly kind: 'BASIC_ATTACK' | 'ABILITY'
  readonly abilityId?: string
}

export interface MissionRotation {
  readonly priority: RotationPriority
  readonly steps: readonly MissionRotationStep[]
}

export interface MissionRotationStrategyTrace {
  readonly rotation: RotationPriority | null
  readonly step: number | null
  readonly fallback: boolean
  readonly skipped: readonly {
    readonly rotation: RotationPriority
    readonly step: number
    readonly reason: RotationSkipReason
  }[]
}

export interface MissionRotationEvaluation {
  /**
   * Unica candidata de la primera rotacion viable: HIGH -> MEDIUM -> LOW.
   * Sin rotacion viable solo existe fallback si el perfil puede atacar.
   */
  readonly legalActions: readonly LegalAction[]
  /**
   * Dada la accion ya resuelta (debe pertenecer a `legalActions`), arma el
   * `StrategyTrace` que le corresponde y avanza UNICAMENTE el cursor de la
   * rotacion que la ofrecio -- nunca el de una candidata que la politica no
   * eligio. Debe llamarse una sola vez, despues de que la politica decida,
   * nunca mientras solo se construyen candidatos.
   */
  readonly resolve: (selected: CombatDecisionSelection) => MissionRotationStrategyTrace
}

export interface MissionRotationInput {
  readonly rotations: readonly MissionRotation[]
  /** Compartido por toda la simulacion (no por turno): misma semantica que el `cursors` original. */
  readonly cursors: Map<number, number>
  readonly abilities: ReadonlyMap<string, CombatAbility>
  readonly cooldowns: ReadonlyMap<string, number>
  readonly power: number
  readonly health: number
  readonly maxHealth: number
  /** True only when authoritative attack and damage stats are both present. */
  readonly canAttack: boolean
  /**
   * Unico combatiente enemigo real en una mision (duelo 1v1): la convencion
   * honesta de Mision para `COMBATANT`, inyectada por quien conoce la
   * identidad (`MissionSimulation`). `SELF`/`ALLIED_GROUP` no llevan payload
   * propio y se construyen aqui mismo.
   */
  readonly enemyTarget: DecisionActionTarget
}

const PRIORITY_ORDER: Readonly<Record<RotationPriority, number>> = { HIGH: 0, MEDIUM: 1, LOW: 2 }

const SELF_TARGET: DecisionActionTarget = Object.freeze({ scope: 'SELF' })
const ALLIED_GROUP_TARGET: DecisionActionTarget = Object.freeze({ scope: 'ALLIED_GROUP' })

/**
 * Si el efecto principal de la habilidad es curacion/soporte (ADR-023,
 * revision de PR #71): solo cuando la habilidad NO ataca este turno
 * (`support.attacks === false`) Y declara HEAL/HEAL_PERCENT. Una habilidad
 * hibrida (dano + curacion secundaria, `attacks: true`) sigue siendo
 * candidata a salud alta -- su efecto principal es ofensivo, no curativo.
 */
const isHealingFocusedAbility = (ability: CombatAbility): boolean => {
  const support = evaluateMissionAbility(ability)
  return (
    support.supported &&
    !support.attacks &&
    support.effects.some((effect) => effect.kind === 'HEAL' || effect.kind === 'HEAL_PERCENT')
  )
}

/** `healthRatio < 0.90` con aritmetica entera, sin redondeo arbitrario (ADR-023). */
const isHealthEligibleForHealing = (health: number, maxHealth: number): boolean =>
  health * 100 < maxHealth * 90

/**
 * Objetivo estrategico real de la habilidad (revision de PR #71), derivado
 * UNICAMENTE de datos reales -- nunca `ENEMY` por defecto:
 *
 * - si el efecto crudo declara un `target` `OPPONENT`/`ENEMY` (dano directo,
 *   debuff, reflejo), o si la habilidad realiza una tirada de ataque este
 *   turno (`support.attacks`, p. ej. un autobuff de Ataque/Daño): `COMBATANT`
 *   contra el enemigo actual;
 * - si no ataca pero algun efecto crudo declara `ALLIED_GROUP`: ese alcance;
 * - en cualquier otro caso (curacion/mejora propia, inmunidad, etc.): `SELF`.
 *
 * No distingue `SELF` de `ALLY` a nivel de efecto crudo: en un duelo de
 * Mision 1v1 no existe un aliado distinto del propio heroe.
 */
const strategicTargetOf = (
  ability: CombatAbility,
  enemyTarget: DecisionActionTarget,
): DecisionActionTarget => {
  const support = evaluateMissionAbility(ability)
  const attacks = support.supported && support.attacks
  const targetsEnemy =
    attacks ||
    ability.effects.some((effect) => effect.target === 'OPPONENT' || effect.target === 'ENEMY')

  if (targetsEnemy) return enemyTarget

  const targetsGroup = ability.effects.some((effect) => effect.target === 'ALLIED_GROUP')

  return targetsGroup ? ALLIED_GROUP_TARGET : SELF_TARGET
}

interface InternalCandidate {
  readonly action: LegalAction
  readonly rotation: RotationPriority
  readonly step: number
  readonly cursorIndex: number
  readonly cursorValue: number
}

const isOffensiveAbility = (ability: CombatAbility): boolean => {
  const support = evaluateMissionAbility(ability)
  return (
    support.supported &&
    (support.attacks ||
      support.effects.some((effect) => effect.kind === 'DIRECT_DAMAGE') ||
      ability.effects.some((effect) => effect.target === 'OPPONENT' || effect.target === 'ENEMY'))
  )
}

/**
 * Restriccion/contexto de Mision (HU-71): filtra que acciones pueden
 * OFRECERSE a una politica de decision (`AiDecisionPort`), sin decidir por
 * ella. Reproduce el algoritmo de prioridad HIGH -> MEDIUM -> LOW y el
 * fallback de ataque basico que usaba `MissionSimulation.chooseAction` antes
 * de EN-035.3, mas la elegibilidad de salud (ADR-023).
 *
 * La prioridad es una regla dura del dominio: al encontrar la primera
 * rotacion viable no se ofrecen prioridades inferiores a ninguna politica.
 */
export class MissionRotationConstraint {
  evaluate(input: MissionRotationInput): MissionRotationEvaluation {
    const sorted = [...input.rotations].sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    )
    const skipped: MissionRotationStrategyTrace['skipped'][number][] = []
    const candidates: InternalCandidate[] = []

    const skipReasonOf = (ability: CombatAbility | undefined): RotationSkipReason | null => {
      if (ability === undefined) return 'UNKNOWN_ABILITY'

      const support = evaluateMissionAbility(ability)

      if (!support.supported) return 'UNSUPPORTED_EFFECT'
      if (!input.canAttack && isOffensiveAbility(ability)) {
        return 'OFFENSIVE_ACTION_NOT_AVAILABLE'
      }
      if ((input.cooldowns.get(ability.abilityId) ?? 0) > 0) return 'ON_COOLDOWN'

      const affordable =
        ability.powerCost.mode === 'ALL_AVAILABLE'
          ? input.power > 0
          : ability.powerCost.amount <= input.power

      if (!affordable) return 'NOT_ENOUGH_POWER'
      if (
        isHealingFocusedAbility(ability) &&
        !isHealthEligibleForHealing(input.health, input.maxHealth)
      ) {
        return 'HEALTH_NOT_ELIGIBLE'
      }

      return null
    }

    for (const [index, rotation] of sorted.entries()) {
      if (rotation.steps.length === 0) continue

      const cursor = (input.cursors.get(index) ?? 0) % rotation.steps.length
      const step = rotation.steps[cursor]

      if (step === undefined) continue

      const stepNumber = cursor + 1

      if (step.kind === 'BASIC_ATTACK') {
        if (!input.canAttack) {
          skipped.push({
            rotation: rotation.priority,
            step: stepNumber,
            reason: 'OFFENSIVE_ACTION_NOT_AVAILABLE',
          })
          continue
        }
        candidates.push({
          action: Object.freeze({ kind: 'BASIC_ATTACK' as const, target: input.enemyTarget }),
          rotation: rotation.priority,
          step: stepNumber,
          cursorIndex: index,
          cursorValue: cursor,
        })
        break
      }

      const ability = step.abilityId === undefined ? undefined : input.abilities.get(step.abilityId)
      const reason = skipReasonOf(ability)

      if (reason !== null || ability === undefined) {
        skipped.push({
          rotation: rotation.priority,
          step: stepNumber,
          reason: reason ?? 'UNKNOWN_ABILITY',
        })
        continue
      }

      candidates.push({
        action: Object.freeze({
          kind: 'ABILITY' as const,
          abilityId: ability.abilityId,
          target: strategicTargetOf(ability, input.enemyTarget),
        }),
        rotation: rotation.priority,
        step: stepNumber,
        cursorIndex: index,
        cursorValue: cursor,
      })
      break
    }

    const firstCandidate = candidates[0]
    const legalActions: readonly LegalAction[] =
      firstCandidate !== undefined
        ? [firstCandidate.action]
        : input.canAttack
          ? [Object.freeze({ kind: 'BASIC_ATTACK' as const, target: input.enemyTarget })]
          : []

    const resolve = (selected: CombatDecisionSelection): MissionRotationStrategyTrace => {
      if (selected.kind === 'END_TURN') {
        return Object.freeze({ rotation: null, step: null, fallback: true, skipped })
      }
      const identity = legalActionIdentity(selected)
      const match = candidates.find(
        (candidate) => legalActionIdentity(candidate.action) === identity,
      )

      if (match === undefined) {
        return Object.freeze({ rotation: null, step: null, fallback: true, skipped })
      }

      input.cursors.set(match.cursorIndex, match.cursorValue + 1)

      return Object.freeze({ rotation: match.rotation, step: match.step, fallback: false, skipped })
    }

    return { legalActions, resolve }
  }
}
