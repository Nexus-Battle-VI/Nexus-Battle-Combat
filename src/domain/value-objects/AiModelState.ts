/**
 * Estados del ciclo de vida de una version de modelo de IA de combate
 * (EN-037.1, Management #570 §11-13; extendido por EN-037.3, #572 §8).
 * Union cerrada, nunca strings libres.
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
 * decidia cuando llamarla (eso quedo para #572, gates automaticos).
 *
 * `#572` (EN-037.3) anade `SUPERSEDED`: el unico estado que puede liberar
 * el slot `active_unique` para que otra version se vuelva ACTIVE, y el
 * unico origen legitimo de un rollback:
 *
 *   ACTIVE -> SUPERSEDED           (al promover un nuevo candidato)
 *   SUPERSEDED -> ACTIVE           (rollback explicito a una version previa)
 *
 * `REJECTED` sigue siendo el UNICO estado terminal de verdad: una version
 * rechazada nunca puede volver a ser ACTIVE, ni por promocion ni por
 * rollback (#572 §8.4). `ACTIVE`/`SUPERSEDED` dejan de ser terminales: se
 * ciclan entre si mediante `supersede()`/`activate()` segun quien este
 * sirviendo produccion en cada momento, pero `isAllowedAiModelStateTransition`
 * sigue siendo la UNICA fuente de verdad del grafo -- `#572` nunca decide
 * "cuando" fuera de el, solo invoca estas primitivas.
 */
export const AiModelState = {
  Training: 'TRAINING',
  Candidate: 'CANDIDATE',
  Evaluating: 'EVALUATING',
  Active: 'ACTIVE',
  Superseded: 'SUPERSEDED',
  Rejected: 'REJECTED',
} as const

export type AiModelState = (typeof AiModelState)[keyof typeof AiModelState]

/** Grafo de transiciones permitidas (#570 §12-13, extendido por #572 §8). Nunca se infiere, siempre explicito. */
const ALLOWED_TRANSITIONS: Readonly<Record<AiModelState, readonly AiModelState[]>> = {
  [AiModelState.Training]: [AiModelState.Candidate, AiModelState.Rejected],
  [AiModelState.Candidate]: [AiModelState.Evaluating, AiModelState.Rejected],
  [AiModelState.Evaluating]: [AiModelState.Active, AiModelState.Rejected],
  [AiModelState.Active]: [AiModelState.Superseded],
  [AiModelState.Superseded]: [AiModelState.Active],
  [AiModelState.Rejected]: [],
}

export const isAllowedAiModelStateTransition = (from: AiModelState, to: AiModelState): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to)

/**
 * (#572 §8.4): solo `REJECTED` es terminal de verdad. `ACTIVE`/`SUPERSEDED`
 * se ciclan entre si (promocion/rollback) y por tanto nunca pertenecen a
 * esta lista -- lo contrario permitiria a `assertRestoredInvariants`
 * aceptar un rollback invalido silenciosamente si algun caller llegara a
 * consultar esta lista para decidir "ya no puede cambiar".
 */
export const TERMINAL_AI_MODEL_STATES: readonly AiModelState[] = [AiModelState.Rejected]

export const isTerminalAiModelState = (state: AiModelState): boolean =>
  (TERMINAL_AI_MODEL_STATES as readonly string[]).includes(state)
