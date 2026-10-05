import { InvalidUtilityStateError } from '../errors/MctsErrors'

/** Version del contrato de utilidad (EN-036.1, Management Task #565, §9). */
export const UTILITY_VERSION_PVE_V1 = 'pve-utility-v1' as const

/** Resultado terminal de la batalla DESDE LA PERSPECTIVA DEL ACTOR RAIZ (§14, §29). */
export type BattleUtilityOutcome = 'WIN' | 'LOSS' | 'NON_TERMINAL'

export interface BattleUtilityActorVitals {
  readonly currentHealth: number
  readonly maxHealth: number
  /**
   * `null` cuando el actor NO tiene sistema de Poder (su perfil no declara
   * `maxPower`, p. ej. un perfil degenerado). NUNCA se rellena con `0`
   * silenciosamente: ver la decision tecnica v1 de `powerRatio` mas abajo.
   */
  readonly power: { readonly current: number; readonly max: number } | null
}

export interface BattleUtilityEnemyVitals {
  readonly currentHealth: number
  readonly maxHealth: number
}

export interface BattleUtilityComponents {
  /** W: resultado terminal, en `[0,1]`. */
  readonly win: number
  /** H: Vida propia restante, en `[0,1]`. */
  readonly health: number
  /** P: Poder propio restante, en `[0,1]`. */
  readonly power: number
  /** D: progreso de dano infligido al equipo rival, en `[0,1]`. */
  readonly damage: number
}

export interface BattleUtilityResult {
  readonly utilityVersion: typeof UTILITY_VERSION_PVE_V1
  /** `U`, ya clamped a `[0,1]` (§9: cada componente clamped y el total tambien). */
  readonly utility: number
  readonly components: BattleUtilityComponents
}

/** Pesos fijos de `pve-utility-v1`: `U = 0.60W + 0.15H + 0.10P + 0.15D` (§9). */
const WEIGHTS = Object.freeze({ win: 0.6, health: 0.15, power: 0.1, damage: 0.15 })

const clamp01 = (value: number, label: string): number => {
  if (!Number.isFinite(value)) {
    throw new InvalidUtilityStateError(`${label} no es un numero finito (${String(value)}).`)
  }
  return Math.min(1, Math.max(0, value))
}

/**
 * W (§14, DECISION TECNICA V1): victoria = 1, derrota = 0, batalla aun no
 * terminal = 0.5 (valor neutral: ni favorece ni penaliza un estado en
 * progreso frente a continuar explorando). El llamador (`MctsSearch`, que SI
 * conoce `BattleRoom.status`/`result`) decide cual de los tres aplica;
 * `BattleUtilityEvaluator` nunca infiere el resultado por si mismo.
 */
const winComponent = (outcome: BattleUtilityOutcome): number => {
  if (outcome === 'WIN') return 1
  if (outcome === 'LOSS') return 0
  return 0.5
}

/**
 * H (§11): `currentHealth / maxHealth` del actor raiz. `maxHealth <= 0` o
 * Vida no finita es un estado corrupto: SE FALLA EXPLICITAMENTE, nunca se
 * oculta con un valor por defecto.
 */
const healthRatio = (actor: BattleUtilityActorVitals): number => {
  if (!Number.isFinite(actor.maxHealth) || actor.maxHealth <= 0) {
    throw new InvalidUtilityStateError(`maxHealth invalido (${String(actor.maxHealth)}).`)
  }
  return clamp01(actor.currentHealth / actor.maxHealth, 'currentHealth/maxHealth')
}

/**
 * P (§12, DECISION TECNICA V1): `currentPower / maxPower` del actor raiz.
 * Si el actor NO tiene sistema de Poder (`power === null`), NO se inventa un
 * `maxPower` ni se trata como `0` (penalizaria injustamente a un actor para
 * el que el Poder estructuralmente no aplica): se usa el valor NEUTRAL `1`
 * (maxima nota en una dimension que no aplica), documentado aqui como la
 * politica v1. Si en el futuro el motor exige Poder en todo perfil valido,
 * esta rama queda inalcanzable, pero se mantiene por contrato defensivo.
 */
const powerRatio = (actor: BattleUtilityActorVitals): number => {
  if (actor.power === null) return 1
  if (!Number.isFinite(actor.power.max) || actor.power.max <= 0) {
    throw new InvalidUtilityStateError(`maxPower invalido (${String(actor.power.max)}).`)
  }
  return clamp01(actor.power.current / actor.power.max, 'currentPower/maxPower')
}

/**
 * D (§13, DECISION TECNICA V1): `1 - (sum currentHealth vivos / sum maxHealth
 * vivos)` de los enemigos del actor raiz (fijo desde el inicio de la busqueda,
 * nunca recalculado por "de quien es el turno" en un nodo). Si no queda
 * ningun enemigo vivo (incluye el caso de lista vacia) el progreso de dano es
 * maximo por definicion: `D = 1`, en vez de dividir por cero.
 */
const damageProgress = (enemies: readonly BattleUtilityEnemyVitals[]): number => {
  const living = enemies.filter((enemy) => enemy.currentHealth > 0)
  if (living.length === 0) return 1

  let currentSum = 0
  let maxSum = 0
  for (const enemy of living) {
    if (!Number.isFinite(enemy.maxHealth) || enemy.maxHealth <= 0) {
      throw new InvalidUtilityStateError(
        `maxHealth de enemigo invalido (${String(enemy.maxHealth)}).`,
      )
    }
    currentSum += enemy.currentHealth
    maxSum += enemy.maxHealth
  }

  return clamp01(1 - currentSum / maxSum, 'progreso de dano')
}

/**
 * Evalua la utilidad `pve-utility-v1` de un estado (terminal o no) SIEMPRE
 * desde la perspectiva del actor raiz de la busqueda MCTS (Management Task
 * #565, §8-§14, §29). Pura: sin RNG, sin IO, sin acceso a `BattleRoom` ni a
 * ningun puerto; el llamador extrae `actor`/`enemies` del nodo que quiera
 * evaluar (raiz o una hoja simulada) y decide `outcome` a partir del
 * resultado real del motor.
 */
export const evaluateBattleUtility = (
  outcome: BattleUtilityOutcome,
  actor: BattleUtilityActorVitals,
  enemies: readonly BattleUtilityEnemyVitals[],
): BattleUtilityResult => {
  const components: BattleUtilityComponents = Object.freeze({
    win: winComponent(outcome),
    health: healthRatio(actor),
    power: powerRatio(actor),
    damage: damageProgress(enemies),
  })

  const utility = clamp01(
    WEIGHTS.win * components.win +
      WEIGHTS.health * components.health +
      WEIGHTS.power * components.power +
      WEIGHTS.damage * components.damage,
    'utilidad total',
  )

  return Object.freeze({ utilityVersion: UTILITY_VERSION_PVE_V1, utility, components })
}
