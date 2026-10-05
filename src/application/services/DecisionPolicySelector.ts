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

/**
 * Selecciona con una primaria OPCIONAL y, solo si no hay primaria, o esta falla
 * o inventa una accion, usa el fallback.
 *
 * Hoy (EN-035/EN-036 aun sin `NeuralPolicy` entrenada) no hay primaria: se
 * construye con `primary: null` y el fallback es `RuleBasedPolicy` (Management
 * #558: "si la politica neuronal no esta disponible, falla o no produce una
 * decision utilizable -> `RuleBasedPolicy`"). El dia que exista una politica
 * entrenable real, esa sera la primaria y `RuleBasedPolicy` sigue siendo el
 * mismo fallback fijo, sin tocar esta clase.
 */
export class DecisionPolicySelector {
  constructor(
    private readonly primary: DecisionPolicyBinding | null,
    private readonly fallback: DecisionPolicyBinding,
  ) {}

  async select(
    state: BattleDecisionState,
    legalActions: readonly LegalAction[],
  ): Promise<SelectedPolicyAction> {
    if (this.primary !== null) {
      try {
        const intent = await this.primary.policy.decide(state, legalActions)

        return { action: resolveLegalAction(intent, legalActions), source: this.primary.source }
      } catch {
        // Sin primaria utilizable (falla o inventa una accion fuera de las legales):
        // cae al fallback fijo, nunca propaga el error de la primaria.
      }
    }

    const intent = await this.fallback.policy.decide(state, legalActions)

    return { action: resolveLegalAction(intent, legalActions), source: this.fallback.source }
  }
}
