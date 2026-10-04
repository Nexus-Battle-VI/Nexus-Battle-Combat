import { DomainError } from './DomainError'

export class DecisionStateUnavailableError extends DomainError {
  constructor(reason: string) {
    super(`No se puede construir una decisión de combate: ${reason}`)
    this.name = 'DecisionStateUnavailableError'
  }
}

export class NoLegalDecisionActionsError extends DomainError {
  constructor() {
    super('El turno actual no contiene acciones legales compatibles con el contrato de decisión.')
    this.name = 'NoLegalDecisionActionsError'
  }
}

export class IllegalActionIntentError extends DomainError {
  constructor() {
    super('La intención no coincide con ninguna acción legal del estado actual.')
    this.name = 'IllegalActionIntentError'
  }
}
