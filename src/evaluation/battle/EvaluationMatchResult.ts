import type { LegalAction } from '../../domain/decision/LegalAction'
import type { EvaluationPolicyId } from '../policies/EvaluationPolicyId'
import type { EvaluationSide } from '../experiment/EvaluationSeedSchedule'

export const EVALUATION_MATCH_RESULT_VERSION = 'evaluation-match-result-v1'

/**
 * Estados de una partida (EN-036.5, Management #569 §101-102): NUNCA se
 * mezclan con "quien gano" -- un `POLICY_FAILURE`/`ENGINE_FAILURE`/
 * `MAX_PLIES`/`INVARIANT_VIOLATION` significa que la partida no produjo un
 * resultado de Combat valido, independientemente de la Vida de cada lado
 * en ese momento.
 */
export type EvaluationMatchStatus =
  'COMPLETED' | 'POLICY_FAILURE' | 'ENGINE_FAILURE' | 'MAX_PLIES' | 'INVARIANT_VIOLATION'

/** #569 §56: cada causa su propio codigo, nunca todas colapsadas a "derrota". */
export type EvaluationPolicyFailureCode =
  | 'NEURAL_TIMEOUT'
  | 'NEURAL_RUNTIME_ERROR'
  | 'NEURAL_INFERENCE_OUTPUT_ERROR'
  | 'MCTS_NO_STRATEGIC_CANDIDATES'
  | 'MCTS_POLICY_ERROR'
  | 'RANDOM_POLICY_ERROR'
  | 'RULE_BASED_POLICY_ERROR'

export interface EvaluationMatchOutcome {
  readonly outcome: 'WIN' | 'NO_WINNER'
  readonly winnerSide: EvaluationSide | null
  readonly reason: string
}

export interface EvaluationSideMetrics {
  readonly damageDealt: number
  readonly healingDone: number
  readonly decisions: number
  readonly actionKindCount: Readonly<Record<LegalAction['kind'], number>>
  readonly finalPower: number | null
  readonly finalHealth: {
    readonly remaining: number
    readonly max: number
    /** Razon 0..1 (normalizada aqui desde el 0..100 de `BattleResult`). */
    readonly lifePercent: number
  } | null
}

/**
 * Contrato versionado de un resultado de partida (#569 §101). Una linea de
 * `matches.jsonl` es exactamente este objeto serializado canonicamente
 * (#569 §58, §178).
 */
export interface EvaluationMatchResultV1 {
  readonly schemaVersion: typeof EVALUATION_MATCH_RESULT_VERSION
  readonly evaluationId: string
  readonly matchId: string
  readonly mirrorPairId: string
  readonly mirrorLeg: 'LEG_1' | 'LEG_2'
  readonly matchupId: string
  readonly scenarioId: string
  readonly matchSeed: number
  readonly combatSeed: number
  readonly policyA: EvaluationPolicyId
  readonly policyB: EvaluationPolicyId
  readonly status: EvaluationMatchStatus
  readonly policyFailureCode: EvaluationPolicyFailureCode | null
  /**
   * Lado cuya politica causo `POLICY_FAILURE`/`INVARIANT_VIOLATION`
   * (#569 §56): `null` para `COMPLETED`, `ENGINE_FAILURE` (fallo del
   * motor, no de una politica) y `MAX_PLIES` (no es culpa de ningun
   * lado). Nunca se adivina: solo se llena cuando el runner identifico
   * exactamente que lado produjo el fallo.
   */
  readonly failedSide: EvaluationSide | null
  readonly outcome: EvaluationMatchOutcome | null
  /** Pasos del harness (incluye `SYSTEM_END_TURN`) -- NUNCA "turnos" (#569 §54, correccion de revision). */
  readonly plies: number
  /** `BattleState.turnsCompleted` real al final de la partida -- la metrica de "turnos" que #569 pide. */
  readonly turnsCompleted: number
  readonly decisionCount: number
  readonly systemEndTurns: number
  readonly invalidPolicySelections: number
  readonly engineRejections: number
  readonly metricsBySide: Readonly<Record<EvaluationSide, EvaluationSideMetrics>>
}
