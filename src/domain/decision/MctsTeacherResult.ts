import type { LegalAction } from './LegalAction'
import { UTILITY_VERSION_PVE_V1 } from '../policies/BattleUtilityEvaluator'

/**
 * Configuracion fija del teacher MCTS `mcts-teacher-v1` (EN-036.1, Management
 * Task #565, §7, §82-§87). Todo numero que gobierna la busqueda vive AQUI,
 * nunca como literal disperso en `MctsSearch`/`MctsTeacher`, para que un
 * `MctsTeacherResult` sea reproducible solo con estos valores + la semilla.
 */
export interface MctsTeacherConfig {
  readonly teacherVersion: 'mcts-teacher-v1'
  readonly utilityVersion: typeof UTILITY_VERSION_PVE_V1
  /** Numero de simulaciones (rollouts) por busqueda. */
  readonly rollouts: number
  /** Profundidad maxima, en semiturnos (plies), de cada simulacion. */
  readonly maxDepthPlies: number
  /** Constante de exploracion UCT (`C`, §20): `exploit + C * sqrt(ln(N_padre)/N_hijo)`. */
  readonly explorationConstant: number
  /** Version de la politica de rollout (siempre `RuleBasedPolicy`, nunca productiva fuera de esto). */
  readonly rolloutPolicyVersion: 'rule-based-v1'
}

/** Unica configuracion v1: DECISION TECNICA, no un default reemplazable en caliente. */
export const MCTS_TEACHER_V1_CONFIG: MctsTeacherConfig = Object.freeze({
  teacherVersion: 'mcts-teacher-v1',
  utilityVersion: UTILITY_VERSION_PVE_V1,
  rollouts: 128,
  maxDepthPlies: 6,
  explorationConstant: Math.SQRT2,
  rolloutPolicyVersion: 'rule-based-v1',
})

export interface MctsCandidateResult {
  readonly action: LegalAction
  /** `legalActionIdentity(action)`: identidad canonica, nunca `JSON.stringify`. */
  readonly actionIdentity: string
  readonly visits: number
  /** Promedio de utilidad `pve-utility-v1` observada en los rollouts que pasaron por este hijo. */
  readonly meanUtility: number
  /** `visits / totalVisits` de todos los candidatos del nodo raiz (distribucion del teacher, §30). */
  readonly probability: number
}

/**
 * Salida versionada y completamente reproducible de una busqueda MCTS
 * (§30-§31): quien la consuma (p. ej. el futuro dataset de #566) puede
 * reproducir el mismo resultado solo con `config` + `simulationSeed` +
 * el `BattleRoom` de entrada, sin volver a tocar el RNG productivo.
 */
export interface MctsTeacherResult {
  readonly config: MctsTeacherConfig
  readonly simulationSeed: number
  readonly stateSchemaVersion: 1
  readonly selectedAction: LegalAction
  /** Ordenados por `visits` descendente; empate resuelto por `actionIdentity` (orden estable). */
  readonly candidates: readonly MctsCandidateResult[]
}
