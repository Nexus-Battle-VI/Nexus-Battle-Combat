import type { AiDecisionPort } from '../ports/AiDecisionPort'
import type { ActionIntent } from '../../domain/decision/ActionIntent'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import { NoLegalDecisionActionsError } from '../../domain/errors/DecisionContractErrors'

/**
 * Baseline determinista (EN-035.3, ADR-023): reproduce el comportamiento
 * aprobado hoy de Misiones -- elige el PRIMER candidato recibido. La
 * prioridad HIGH/MEDIUM/LOW y el ataque basico de respaldo de HU-71 ya
 * quedaron resueltos por quien construyo `legalActions` (p. ej.
 * `MissionRotationConstraint`); esta politica no conoce rotaciones, cursores
 * ni Misiones, para poder reutilizarse tal cual fuera de ese contexto
 * (p. ej. JcE) el dia que haga falta.
 *
 * Sin RNG, sin estado, sin efectos secundarios: no persiste, no consulta
 * servicios, no muta `state` ni `legalActions`, nunca fabrica una accion que
 * no estuviera ya en `legalActions`.
 */
export class RuleBasedPolicy implements AiDecisionPort {
  decide(_state: BattleDecisionState, legalActions: readonly LegalAction[]): Promise<ActionIntent> {
    const [first] = legalActions

    if (first === undefined) {
      return Promise.reject(new NoLegalDecisionActionsError())
    }

    return Promise.resolve(first)
  }
}
