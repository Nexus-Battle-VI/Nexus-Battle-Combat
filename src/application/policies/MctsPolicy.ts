import type { ActionIntent } from '../../domain/decision/ActionIntent'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { MctsTeacherConfig, MctsTeacherResult } from '../../domain/decision/MctsTeacherResult'
import { MCTS_TEACHER_V1_CONFIG } from '../../domain/decision/MctsTeacherResult'
import { MctsRoomContextRequiredError } from '../../domain/errors/MctsErrors'
import type { AiDecisionPort } from '../ports/AiDecisionPort'
import type { MctsSearch } from '../services/MctsSearch'

/**
 * Politica MCTS (EN-036.1, Management Task #565). NUNCA es productiva: no se
 * wire a `DecisionPolicySelector` ni se invoca desde `ExecuteAiTurn`. Su
 * unico consumidor es tooling de teacher/dataset (p. ej. el futuro #566).
 *
 * `decide()` existe SOLO para que la clase declare `AiDecisionPort` por tipo
 * (documentacion/uniformidad con `RuleBasedPolicy`/`RandomPolicy`); siempre
 * rechaza explicitamente (`MctsRoomContextRequiredError`) en vez de aproximar
 * una busqueda con datos insuficientes: `BattleDecisionState` no alcanza para
 * reconstruir una sala simulable (hallazgo de auditoria previa). El metodo
 * real es `teach()`, que SI recibe el `BattleRoom` autoritativo completo.
 */
export class MctsPolicy implements AiDecisionPort {
  constructor(
    private readonly search: MctsSearch,
    private readonly config: MctsTeacherConfig = MCTS_TEACHER_V1_CONFIG,
  ) {}

  decide(state: BattleDecisionState, legalActions: readonly LegalAction[]): Promise<ActionIntent> {
    void state
    void legalActions
    return Promise.reject(new MctsRoomContextRequiredError())
  }

  /**
   * Ejecuta una busqueda MCTS completa sobre `room` (debe estar `IN_BATTLE`
   * y ser el turno del actor que se quiere ensenar) con `simulationSeed`
   * como raiz de todas las semillas de rollout: la misma `room` + semilla +
   * `config` siempre reproduce exactamente el mismo `MctsTeacherResult`.
   */
  teach(room: BattleRoom, simulationSeed: number): Promise<MctsTeacherResult> {
    return this.search.search(room, this.config, simulationSeed)
  }
}
