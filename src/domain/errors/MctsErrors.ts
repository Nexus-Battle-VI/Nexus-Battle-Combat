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
