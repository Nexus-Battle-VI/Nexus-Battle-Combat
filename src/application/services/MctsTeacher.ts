import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { MctsTeacherConfig, MctsTeacherResult } from '../../domain/decision/MctsTeacherResult'
import { MCTS_TEACHER_V1_CONFIG } from '../../domain/decision/MctsTeacherResult'
import type { MctsSearch } from './MctsSearch'

/**
 * Entrada publica del teacher MCTS (EN-036.1, Management Task #565). NUNCA es
 * productiva: no se wire a `DecisionPolicySelector` ni se invoca desde
 * `ExecuteAiTurn`. Su unico consumidor es tooling de teacher/dataset (p. ej.
 * el futuro #566).
 *
 * DELIBERADAMENTE no implementa `AiDecisionPort` (correccion tras la revision
 * de PR#80): un `AiDecisionPort.decide(state, legalActions)` solo recibe
 * `BattleDecisionState`, que no alcanza para reconstruir una sala simulable
 * (sin snapshot completo, cooldowns ni efectos internos). Fingir esa interfaz
 * y hacer que `decide()` rechace siempre era deshonesto con el contrato y,
 * ademas, choca con el caso de uso real de un dataset offline: un
 * `CombatDecisionEvent` persistido guarda `stateBefore: BattleDecisionState`,
 * nunca el `BattleRoom` completo, asi que ninguna implementacion de
 * `AiDecisionPort` podria reconstruir la simulacion a partir de telemetria ya
 * guardada. `teach()` es el unico metodo real: recibe el `BattleRoom`
 * autoritativo completo, siempre en el momento en que existe (en vivo, nunca
 * reconstruido despues de los hechos).
 *
 * GAP FORMALMENTE ABIERTO para #566 (no resuelto por este archivo): la
 * condicion de #565 "MCTS puede generar una etiqueta/distribución para un
 * decision state" asume poder re-etiquetar una decision YA persistida. Con el
 * contrato actual de `CombatDecisionEvent` eso no es posible; `teach()` solo
 * sirve para etiquetar una decision EN VIVO (con su `BattleRoom` a mano). Si
 * el dataset offline de #566 necesita reetiquetar telemetria historica,
 * Management debe decidir entre (a) enriquecer `CombatDecisionEvent` con
 * suficiente estado para reconstruir una sala simulable, o (b) limitar el
 * teacher a producir labels solo para decisiones en vivo (p. ej. corriendo
 * `teach()` en paralelo a la decision real, antes de persistir el evento).
 */
export class MctsTeacher {
  constructor(
    private readonly search: MctsSearch,
    private readonly config: MctsTeacherConfig = MCTS_TEACHER_V1_CONFIG,
  ) {}

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
