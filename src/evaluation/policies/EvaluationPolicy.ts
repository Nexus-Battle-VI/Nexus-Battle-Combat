import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { EvaluationSide } from '../experiment/EvaluationSeedSchedule'
import type { EvaluationPolicyId } from './EvaluationPolicyId'

/**
 * Abstraccion EXCLUSIVA del harness (EN-036.5, Management #569 §14): nunca
 * productiva, nunca implementada por `AiDecisionPort`. MCTS necesita el
 * `BattleRoom` completo (clonable, simulable), no solo el
 * `BattleDecisionState` observable que reciben Random/RuleBased/Neural --
 * forzarlo a `AiDecisionPort` ya se descarto correctamente en #565/#555.
 * `EvaluationPolicy` es el denominador comun que SI necesitan las 4
 * politicas: ademas del estado observable, el `room` (para MCTS), la
 * semilla raiz y el indice de decision (para derivar semillas propias,
 * #569 §28) y el lado (A/B, para que el seed schedule separe RNGs por
 * lado, #569 §27, §148).
 */
export interface EvaluationDecisionContext {
  readonly room: BattleRoom
  readonly state: BattleDecisionState
  readonly legalActions: readonly LegalAction[]
  readonly matchSeed: number
  readonly decisionIndex: number
  readonly side: EvaluationSide
}

export interface EvaluationPolicy {
  readonly id: EvaluationPolicyId

  /**
   * Devuelve SIEMPRE la `LegalAction` canonica (la misma referencia de
   * `context.legalActions`, ya resuelta via `resolveLegalAction`): el
   * runner vuelve a validarla de todas formas (defensa en profundidad,
   * #569 §23-24), pero esta interfaz nunca expone un `ActionIntent` sin
   * resolver.
   */
  decide(context: EvaluationDecisionContext): Promise<LegalAction>
}
