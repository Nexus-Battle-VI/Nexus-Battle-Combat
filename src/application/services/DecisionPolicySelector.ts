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
 * Desde EN-036.4 (#568): por defecto (`NEURAL_POLICY_ENABLED=false`) se
 * construye con `primary: null`, exactamente como antes. Con la variable
 * activa y un artefacto ONNX valido/con hash verificado, la primaria es
 * `NeuralPolicy` (ver `infrastructure/ai/NeuralModelArtifactLoader.ts`). En
 * cualquier otro caso (deshabilitada, carga fallida, schema incompatible,
 * runtime nativo no disponible) sigue siendo `null`. El fallback SIEMPRE es
 * `RuleBasedPolicy` (Management #558: "si la politica neuronal no esta
 * disponible, falla o no produce una decision utilizable ->
 * `RuleBasedPolicy`") -- esta clase no cambia segun cual sea la primaria.
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
