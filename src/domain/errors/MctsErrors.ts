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
 * Existen acciones legales (Combat las permitiria), pero NINGUNA sobrevive
 * `filterStrategicCandidates`/la interseccion con la rotacion de Mision: p.
 * ej. un sanador cuya unica accion es una curacion y todos sus receptores ya
 * estan por encima del umbral de la regla de salud (EN-036 #555). Nunca se
 * reintroducen esas candidatas "desperdiciadas" solo para que el teacher
 * tenga algo que etiquetar -- eso violaria la regla en vez de respetarla.
 * Distinto de `NoLegalDecisionActionsError`: aqui SI hay acciones legales,
 * ninguna es, con certeza estructural, una candidata ESTRATEGICA.
 */
export class NoStrategicMctsCandidatesError extends DomainError {
  constructor() {
    super(
      'Hay acciones legales, pero ninguna es una candidata estrategica para el teacher MCTS (p. ej. las unicas opciones son curaciones ya innecesarias).',
    )
    this.name = 'NoStrategicMctsCandidatesError'
  }
}

/**
 * Ya existe un `MctsTeacherLabel` persistido para `eventId` con contenido
 * DISTINTO del que se intenta anadir (EN-036.2 #566, correccion de alcance
 * sobre PR#81). El mismo label repetido byte a byte es idempotente (no es
 * error); esto solo salta ante una inconsistencia real -- nunca se
 * sobrescribe en silencio.
 */
export class MctsTeacherLabelConflictError extends DomainError {
  constructor(readonly eventId: string) {
    super(`Ya existe un MctsTeacherLabel distinto para eventId="${eventId}".`)
    this.name = 'MctsTeacherLabelConflictError'
  }
}

/**
 * El `MctsTeacherResult` que acaba de producir `MctsTeacher.teach()` no
 * cumple la relacion exigida con su `CombatDecisionEvent` (§5 de la
 * correccion de alcance sobre PR#81): `stateSchemaVersion` no coincide, o
 * algun candidato no pertenece a `legalActions`. Nunca se persiste un label
 * en este estado; se trata como cualquier otro fallo fail-open de
 * `LiveMctsTeacherLabeler`.
 */
export class MctsTeacherLabelValidationError extends DomainError {
  constructor(reason: string) {
    super(`MctsTeacherLabel invalido: ${reason}`)
    this.name = 'MctsTeacherLabelValidationError'
  }
}
