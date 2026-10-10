import { RuleBasedPolicy } from '../../application/policies/RuleBasedPolicy'
import { resolveLegalAction } from '../../domain/decision/ActionIdentity'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { EvaluationDecisionContext, EvaluationPolicy } from './EvaluationPolicy'

/**
 * Envuelve `RuleBasedPolicy` sin cambiar su comportamiento (EN-036.5,
 * Management #569 §16): sin RNG, sin estado, el mismo baseline
 * determinista que ya usa produccion.
 */
export class RuleBasedEvaluationPolicy implements EvaluationPolicy {
  readonly id = 'RULE_BASED' as const

  private readonly inner = new RuleBasedPolicy()

  async decide(context: EvaluationDecisionContext): Promise<LegalAction> {
    const intent = await this.inner.decide(context.state, context.legalActions)

    return resolveLegalAction(intent, context.legalActions)
  }
}
