import { DomainError } from './DomainError'

/**
 * Un dato de entrada a `BattleUtilityEvaluator` es estructuralmente invalido
 * (p. ej. `maxHealth <= 0`, Vida/Poder no finitos). El evaluador NUNCA oculta
 * un estado corrupto detras de un valor neutral: falla explicitamente.
 */
export class InvalidUtilityStateError extends DomainError {
  constructor(reason: string) {
    super(`Estado de utilidad invalido: ${reason}`)
    this.name = 'InvalidUtilityStateError'
  }
}

/** La configuracion del teacher MCTS (EN-036.1) no cumple sus invariantes documentadas. */
export class InvalidMctsConfigError extends DomainError {
  constructor(reason: string) {
    super(`Configuracion MCTS invalida: ${reason}`)
    this.name = 'InvalidMctsConfigError'
  }
}

/**
 * Una simulacion aislada de MCTS no pudo completar un paso (p. ej. la sala
 * clonada desaparecio del repositorio en memoria, o un `commandId` de
 * simulacion colisiono). Nunca indica un problema de las reglas reales de
 * Combat: siempre es un defecto del arnes de simulacion en si mismo.
 */
export class SimulationTransitionError extends DomainError {
  constructor(reason: string) {
    super(`Transicion de simulacion MCTS invalida: ${reason}`)
    this.name = 'SimulationTransitionError'
  }
}

/**
 * `MctsPolicy.decide(state, legalActions)` existe solo para cumplir
 * `AiDecisionPort` por tipo: `BattleDecisionState` (el contrato de
 * `decide`) no alcanza para reconstruir una sala simulable fielmente (no
 * lleva snapshot, eventos ni cooldowns internos no expuestos). MCTS SIEMPRE
 * necesita el `BattleRoom` real, que solo `MctsPolicy.teach()` recibe. Esto
 * es deliberado (Management Task #565, auditoria previa, hallazgo A): nunca
 * se aproxima una busqueda con datos insuficientes.
 */
export class MctsRoomContextRequiredError extends DomainError {
  constructor() {
    super(
      'MctsPolicy.decide() no puede operar solo con BattleDecisionState: use MctsPolicy.teach(room, simulationSeed), que recibe el BattleRoom real.',
    )
    this.name = 'MctsRoomContextRequiredError'
  }
}
