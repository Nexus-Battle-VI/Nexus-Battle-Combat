import type { CombatAbility } from '../../domain/entities/CombatProfile'
import type { DecisionActionTarget, LegalAction } from '../../domain/decision/LegalAction'
import { evaluateMissionAbility } from '../../domain/policies/MissionAbilityPolicy'

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
   * Candidatas ofrecidas a la politica de decision. En v1 tiene como mucho 1
   * elemento (ver nota de diseño de la clase): el algoritmo se detiene en la
   * PRIMERA rotacion viable, igual que el `chooseAction()` que reemplaza.
   */
  readonly legalActions: readonly LegalAction[]
  readonly strategy: MissionRotationStrategyTrace
  /**
   * Avanza el cursor de la rotacion ganadora. Debe llamarse UNICAMENTE
   * despues de que la politica decida, nunca mientras solo se construyen
   * candidatos -- evita que explorar candidatas (p. ej. una futura
   * `NeuralPolicy` evaluando varias) adelante un cursor por error.
   */
  readonly commit: () => void
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
  /**
   * Unico objetivo estrategico real en una mision (duelo 1v1): tanto el
   * ataque basico como cualquier habilidad se ofrecen contra el enemigo
   * actual. Las habilidades que en realidad son mejoras propias aplican su
   * efecto sobre el heroe igualmente (`applyEffect` ya lo resuelve por el
   * `target` del EFECTO, no por el de la accion); el "objetivo" de la accion
   * aqui es la convencion honesta de Mision, no una eleccion de la politica.
   */
  readonly target: DecisionActionTarget
}

const PRIORITY_ORDER: Readonly<Record<RotationPriority, number>> = { HIGH: 0, MEDIUM: 1, LOW: 2 }

/** Si el efecto principal de la habilidad es curacion (ADR-023), via la unica fuente autoritativa. */
const isHealingAbility = (ability: CombatAbility): boolean => {
  const support = evaluateMissionAbility(ability)
  return (
    support.supported &&
    support.effects.some((effect) => effect.kind === 'HEAL' || effect.kind === 'HEAL_PERCENT')
  )
}

/** `healthRatio < 0.90` con aritmetica entera, sin redondeo arbitrario (ADR-023). */
const isHealthEligibleForHealing = (health: number, maxHealth: number): boolean =>
  health * 100 < maxHealth * 90

/**
 * Restriccion/contexto de Mision (HU-71): filtra que accion puede OFRECERSE a
 * una politica de decision (`AiDecisionPort`), sin decidir por ella.
 * Reproduce exactamente el algoritmo de prioridad HIGH -> MEDIUM -> LOW y el
 * fallback de ataque basico que usaba `MissionSimulation.chooseAction` antes
 * de EN-035.3, mas la elegibilidad de salud nueva.
 *
 * DECISION DE DISEÑO v1 (EN-035.3, ver tambien ADR-023 "Rotaciones como
 * restriccion"): igual que el algoritmo original, la evaluacion se detiene en
 * la PRIMERA rotacion viable -- nunca evalua las de menor prioridad una vez
 * encontro una candidata, para no alterar ni el `skipped` ni el resultado que
 * ya aprobaron los tests de HU-71 (regresion dorada). Por eso `legalActions`
 * tiene como mucho 1 elemento hoy. Una politica mas rica que necesite elegir
 * SIMULTANEAMENTE entre varias rotaciones viables (p. ej. una futura
 * `NeuralPolicy`) requerira evaluar TODAS las rotaciones sin detenerse, lo
 * cual es un cambio de comportamiento deliberadamente fuera de alcance aqui:
 * esta Task preserva el resultado aprobado, no lo mejora.
 */
export class MissionRotationConstraint {
  evaluate(input: MissionRotationInput): MissionRotationEvaluation {
    const sorted = [...input.rotations].sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    )
    const skipped: MissionRotationStrategyTrace['skipped'][number][] = []

    const skipReasonOf = (ability: CombatAbility | undefined): RotationSkipReason | null => {
      if (ability === undefined) return 'UNKNOWN_ABILITY'

      const support = evaluateMissionAbility(ability)

      if (!support.supported) return 'UNSUPPORTED_EFFECT'
      if ((input.cooldowns.get(ability.abilityId) ?? 0) > 0) return 'ON_COOLDOWN'

      const affordable =
        ability.powerCost.mode === 'ALL_AVAILABLE'
          ? input.power > 0
          : ability.powerCost.amount <= input.power

      if (!affordable) return 'NOT_ENOUGH_POWER'
      if (isHealingAbility(ability) && !isHealthEligibleForHealing(input.health, input.maxHealth)) {
        return 'HEALTH_NOT_ELIGIBLE'
      }

      return null
    }

    for (const [index, rotation] of sorted.entries()) {
      if (rotation.steps.length === 0) continue

      const cursor = (input.cursors.get(index) ?? 0) % rotation.steps.length
      const step = rotation.steps[cursor]

      if (step === undefined) continue

      const position = { rotation: rotation.priority, step: cursor + 1 }

      if (step.kind === 'BASIC_ATTACK') {
        return {
          legalActions: [Object.freeze({ kind: 'BASIC_ATTACK' as const, target: input.target })],
          strategy: Object.freeze({ ...position, fallback: false, skipped }),
          commit: () => input.cursors.set(index, cursor + 1),
        }
      }

      const ability = step.abilityId === undefined ? undefined : input.abilities.get(step.abilityId)
      const reason = skipReasonOf(ability)

      if (reason !== null || ability === undefined) {
        skipped.push({ ...position, reason: reason ?? 'UNKNOWN_ABILITY' })
        continue
      }

      return {
        legalActions: [
          Object.freeze({
            kind: 'ABILITY' as const,
            abilityId: ability.abilityId,
            target: input.target,
          }),
        ],
        strategy: Object.freeze({ ...position, fallback: false, skipped }),
        commit: () => input.cursors.set(index, cursor + 1),
      }
    }

    return {
      legalActions: [Object.freeze({ kind: 'BASIC_ATTACK' as const, target: input.target })],
      strategy: Object.freeze({ rotation: null, step: null, fallback: true, skipped }),
      // El fallback no pertenece a ninguna rotación: no hay cursor que avanzar.
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      commit: () => {},
    }
  }
}
