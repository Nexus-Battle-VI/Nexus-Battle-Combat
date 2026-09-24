/**
 * Politica de reintentos de un `RewardWorkflow` ante fallos TRANSITORIOS
 * (`hu-22-reward-contract-v1` §8.1, §13: "timeouts + retry acotado").
 *
 * Antes no habia espera ni tope: el barrido reintentaba cada segundo, para
 * siempre, cualquier fallo que no fuera un rechazo terminal. Un solo workflow
 * llego a 26 917 intentos (uno por segundo, durante ~7 h) contra un destino que
 * respondia siempre lo mismo.
 *
 * NO usa columnas nuevas a proposito: la coleccion `reward-workflows` tiene un
 * validador `$jsonSchema` con `additionalProperties: false` (migracion 010), y
 * una escritura con un campo no declarado falla. Se deriva de lo que ya se
 * persiste: `attempts` (fallos transitorios acumulados) y `updatedAt` (que
 * `registerRetryableFailure` fija en el instante del ultimo fallo).
 */
export interface RewardRetryPolicy {
  /** Espera tras el primer fallo; se duplica en cada fallo siguiente. */
  readonly baseDelayMs: number
  /** Techo de la espera entre dos intentos. */
  readonly maxDelayMs: number
  /**
   * Fallos transitorios acumulados tras los cuales el workflow pasa a
   * `TERMINAL_FAILURE` en vez de seguir reintentandose sin fin.
   */
  readonly maxAttempts: number
}

/**
 * 1 s, 2 s, 4 s... hasta 5 min entre intentos, y 100 fallos en total: unas
 * 7,7 h de reintentos antes de rendirse. Es una decision de operacion, no de
 * producto: ni el contrato ni la HU fijan cifras. Ajustarlas es cambiar esta
 * constante.
 */
export const DEFAULT_REWARD_RETRY_POLICY: RewardRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  maxAttempts: 100,
}

/** Espera antes del siguiente intento, tras `failedAttempts` fallos transitorios. */
export const rewardRetryDelayMs = (policy: RewardRetryPolicy, failedAttempts: number): number =>
  failedAttempts <= 0
    ? 0
    : Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failedAttempts - 1))

/** Si ya paso la espera desde el ultimo fallo. Sin fallos previos siempre esta vencida. */
export const isRewardRetryDue = (
  policy: RewardRetryPolicy,
  workflow: { readonly attempts: number; readonly updatedAt: Date },
  now: Date,
): boolean =>
  // Sin fallos previos no hay nada que esperar, aunque `updatedAt` quede por
  // delante del reloj (un ajuste de hora hacia atras no debe dejar un workflow
  // recien creado sin procesar).
  workflow.attempts <= 0 ||
  now.getTime() - workflow.updatedAt.getTime() >= rewardRetryDelayMs(policy, workflow.attempts)

/** Si un fallo transitorio mas agota el tope de `attempts` ya acumulados. */
export const isRewardRetryExhausted = (
  policy: RewardRetryPolicy,
  attemptsAfterFailure: number,
): boolean => attemptsAfterFailure >= policy.maxAttempts
