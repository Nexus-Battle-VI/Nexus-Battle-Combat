import { RandomPolicy } from '../../application/policies/RandomPolicy'
import { createBoundedRandom } from '../../application/services/BoundedRandom'
import type { RandomSequencePort } from '../../application/ports/RandomSequencePort'
import { resolveLegalAction } from '../../domain/decision/ActionIdentity'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { EvaluationDecisionContext, EvaluationPolicy } from './EvaluationPolicy'

/**
 * Envuelve `RandomPolicy` (EN-036.5, Management #569 §15) sobre una
 * `RandomSequencePort` propia del harness -- derivada de
 * `deriveRandomPolicySeed` (ver `EvaluationSeedSchedule.ts`), nunca
 * `Math.random()` y nunca el cursor de Combat ni de MCTS de esa misma
 * partida. Una instancia vive UNA partida completa: la secuencia es
 * continua a lo largo de todas las decisiones de este lado (#569 §148),
 * nunca reiniciada por decision.
 */
export class RandomEvaluationPolicy implements EvaluationPolicy {
  readonly id = 'RANDOM' as const

  private readonly inner: RandomPolicy

  constructor(sequence: RandomSequencePort) {
    this.inner = new RandomPolicy(createBoundedRandom(sequence))
  }

  async decide(context: EvaluationDecisionContext): Promise<LegalAction> {
    const intent = await this.inner.decide(context.state, context.legalActions)

    return resolveLegalAction(intent, context.legalActions)
  }
}
