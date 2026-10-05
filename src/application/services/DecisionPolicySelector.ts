import type { AiDecisionPort } from '../ports/AiDecisionPort'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import { resolveLegalAction } from '../../domain/decision/ActionIdentity'
import type { CombatDecisionSource } from '../../domain/decision/CombatDecisionEvent'

export interface DecisionPolicyBinding {
  readonly policy: AiDecisionPort
  readonly source: Exclude<CombatDecisionSource, 'HUMAN' | 'SYSTEM'>
}

export interface SelectedPolicyAction {
  readonly action: LegalAction
  readonly source: DecisionPolicyBinding['source']
}

/** Selecciona con una primaria y, solo si esta falla o inventa una accion, usa un fallback. */
export class DecisionPolicySelector {
  constructor(
    private readonly primary: DecisionPolicyBinding,
    private readonly fallback: DecisionPolicyBinding,
  ) {}

  async select(
    state: BattleDecisionState,
    legalActions: readonly LegalAction[],
  ): Promise<SelectedPolicyAction> {
    try {
      const intent = await this.primary.policy.decide(state, legalActions)

      return { action: resolveLegalAction(intent, legalActions), source: this.primary.source }
    } catch {
      const intent = await this.fallback.policy.decide(state, legalActions)

      return { action: resolveLegalAction(intent, legalActions), source: this.fallback.source }
    }
  }
}
