import type {
  CombatDecisionEvent,
  CombatDecisionOrigin,
  CombatDecisionOutcomeEvent,
  CombatDecisionTelemetryEvent,
} from '../../domain/decision/CombatDecisionEvent'

export class CombatDecisionTelemetryConflictError extends Error {
  constructor(readonly eventId: string) {
    super(`El evento de telemetría "${eventId}" ya existe con otro contenido.`)
    this.name = 'CombatDecisionTelemetryConflictError'
  }
}

/** Puerto append-only. No ofrece actualización ni borrado deliberadamente. */
export interface CombatDecisionTelemetryRepositoryPort {
  append(event: CombatDecisionTelemetryEvent): Promise<void>
  appendMany(events: readonly CombatDecisionTelemetryEvent[]): Promise<void>
  listDecisionsByBattle(
    origin: CombatDecisionOrigin,
    battleId: string,
  ): Promise<readonly CombatDecisionEvent[]>
  findOutcome(
    origin: CombatDecisionOrigin,
    battleId: string,
  ): Promise<CombatDecisionOutcomeEvent | null>
}

export const COMBAT_DECISION_TELEMETRY_REPOSITORY = Symbol('CombatDecisionTelemetryRepositoryPort')
