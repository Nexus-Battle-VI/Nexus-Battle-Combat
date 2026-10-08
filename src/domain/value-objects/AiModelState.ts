/**
 * Estados del ciclo de vida de una version de modelo de IA de combate
 * (EN-037.1, Management #570 §11-13). Union cerrada, nunca strings libres.
 *
 * Ruta normal:
 *
 *   TRAINING -> CANDIDATE -> EVALUATING -> ACTIVE | REJECTED
 *
 * Rechazos tempranos tambien permitidos (#570 §13): un training que
 * fallo, o un artefacto corrupto/incompatible detectado ANTES de llegar a
 * evaluacion, deben poder registrarse como rechazados sin forzar el paso
 * por `EVALUATING`:
 *
 *   TRAINING -> REJECTED
 *   CANDIDATE -> REJECTED
 *
 * `EVALUATING -> REJECTED` es obligatoria (#570 §13).
 *
 * `EVALUATING -> ACTIVE` es la PRIMITIVA segura que #570 expone; #570 NO
 * decide cuando llamarla (eso es #572, gates automaticos). Por eso
 * `ACTIVE`/`REJECTED` son terminales aqui: que pasa con un ACTIVE anterior
 * al promover uno nuevo, o si existe rollback, lo define #572 -- #570 no
 * inventa esa semantica.
 */
export const AiModelState = {
  Training: 'TRAINING',
  Candidate: 'CANDIDATE',
  Evaluating: 'EVALUATING',
  Active: 'ACTIVE',
  Rejected: 'REJECTED',
} as const

export type AiModelState = (typeof AiModelState)[keyof typeof AiModelState]

/** Grafo de transiciones permitidas (#570 §12-13). Nunca se infiere, siempre explicito. */
const ALLOWED_TRANSITIONS: Readonly<Record<AiModelState, readonly AiModelState[]>> = {
  [AiModelState.Training]: [AiModelState.Candidate, AiModelState.Rejected],
  [AiModelState.Candidate]: [AiModelState.Evaluating, AiModelState.Rejected],
  [AiModelState.Evaluating]: [AiModelState.Active, AiModelState.Rejected],
  [AiModelState.Active]: [],
  [AiModelState.Rejected]: [],
}

export const isAllowedAiModelStateTransition = (from: AiModelState, to: AiModelState): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to)

export const TERMINAL_AI_MODEL_STATES: readonly AiModelState[] = [
  AiModelState.Active,
  AiModelState.Rejected,
]

export const isTerminalAiModelState = (state: AiModelState): boolean =>
  (TERMINAL_AI_MODEL_STATES as readonly string[]).includes(state)
