import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { MctsTeacherConfig, MctsTeacherResult } from '../../domain/decision/MctsTeacherResult'
import { MCTS_TEACHER_V1_CONFIG } from '../../domain/decision/MctsTeacherResult'
import type { MctsSearch } from './MctsSearch'
import type { MissionRotationInput } from './MissionRotationConstraint'

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
 * DECISION FORMALIZADA para #566 ("labels en vivo", 2026-10-05): la condicion
 * de #565 "MCTS puede generar una etiqueta/distribución para un decision
 * state" se satisface EN EL MOMENTO en que existe un `BattleRoom` real, nunca
 * reconstruyendo uno a partir de un `CombatDecisionEvent` ya persistido (que
 * solo guarda `stateBefore: BattleDecisionState`, insuficiente para simular).
 * #566 debe producir sus etiquetas llamando a `teach()` EN PARALELO a la
 * decision real -- antes o al momento de persistir el `CombatDecisionEvent`
 * correspondiente, nunca despues -- y guardar el `MctsTeacherResult` junto a
 * (o referenciado desde) ese evento. Se descarta deliberadamente la
 * alternativa de enriquecer `CombatDecisionEvent` con snapshot suficiente
 * para re-simular offline: es mas invasiva (infla el contrato de telemetria
 * de EN-035.4 para todas las fuentes, no solo MCTS) sin necesidad real, ya
 * que el teacher nunca necesita conocimiento del futuro, solo del
 * `BattleRoom` del momento.
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
   *
   * `rotationInput`, SOLO en un contexto de Mision: restringe la raiz a la
   * interseccion con `MissionRotationConstraint` (ver `MctsSearch.search`).
   */
  teach(
    room: BattleRoom,
    simulationSeed: number,
    rotationInput?: MissionRotationInput,
  ): Promise<MctsTeacherResult> {
    return this.search.search(room, this.config, simulationSeed, rotationInput)
  }
}
