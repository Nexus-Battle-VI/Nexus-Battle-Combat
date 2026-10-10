import type { CombatDecisionSource } from '../../domain/decision/CombatDecisionEvent'

/**
 * Reutiliza LITERALMENTE los 4 strings ya productivos de
 * `CombatDecisionSource` (EN-036.5, Management #569 §98-100): nunca un
 * vocabulario paralelo ("rules"/"rb"/"neural-v1") inventado solo para el
 * harness. `HUMAN`/`SYSTEM` no son politicas de evaluacion -- se excluyen
 * aqui, no en `CombatDecisionSource`, que sigue siendo el tipo productivo
 * sin cambios.
 */
export type EvaluationPolicyId = Extract<
  CombatDecisionSource,
  'RANDOM' | 'RULE_BASED' | 'MCTS' | 'NEURAL'
>

export const EVALUATION_POLICY_IDS: readonly EvaluationPolicyId[] = [
  'RANDOM',
  'RULE_BASED',
  'MCTS',
  'NEURAL',
]
