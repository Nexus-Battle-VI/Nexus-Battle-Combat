import type { AiDecisionPort } from '../ports/AiDecisionPort'
import type { ActionIntent } from '../../domain/decision/ActionIntent'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import { NoLegalDecisionActionsError } from '../../domain/errors/DecisionContractErrors'
import type { BoundedRandom } from '../../domain/policies/TurnOrderPolicy'

/**
 * Piso experimental (EN-035.3, ADR-023): elige uniformemente entre
 * `legalActions` usando el `BoundedRandom` que recibe por constructor --
 * SIEMPRE un stream de SIMULACION aislado (ver `createBoundedRandom` sobre
 * una `RandomSequencePort` propia), nunca el stream vivo de resolucion de
 * una batalla real (daño/critico/efectos, ADR-021): compartir cursor
 * cambiaria los resultados de esa batalla solo por haber explorado una
 * decision. No usa `Math.random`, `crypto.random*` ni `Date.now`.
 *
 * Sin estado propio ademas del stream inyectado, sin mutar `state` ni
 * `legalActions`, nunca devuelve una accion fuera de `legalActions`.
 */
export class RandomPolicy implements AiDecisionPort {
  constructor(private readonly random: BoundedRandom) {}

  decide(_state: BattleDecisionState, legalActions: readonly LegalAction[]): Promise<ActionIntent> {
    if (legalActions.length === 0) {
      return Promise.reject(new NoLegalDecisionActionsError())
    }

    const index = this.random.nextInt(legalActions.length)
    const chosen = legalActions[index]

    if (chosen === undefined) {
      return Promise.reject(new NoLegalDecisionActionsError())
    }

    return Promise.resolve(chosen)
  }
}
