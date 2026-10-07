import {
  CombatDecisionTelemetryConflictError,
  type CombatDecisionTelemetryRepositoryPort,
} from '../../../application/ports/CombatDecisionTelemetryRepositoryPort'
import type {
  CombatDecisionEvent,
  CombatDecisionOrigin,
  CombatDecisionOutcomeEvent,
  CombatDecisionTelemetryEvent,
} from '../../../domain/decision/CombatDecisionEvent'
import {
  isDecisionEvent,
  isOutcomeEvent,
  sameCombatDecisionTelemetryEvent,
} from './combat-decision-event-mapping'

export class InMemoryCombatDecisionTelemetryRepository implements CombatDecisionTelemetryRepositoryPort {
  private readonly events = new Map<string, CombatDecisionTelemetryEvent>()

  append(event: CombatDecisionTelemetryEvent): Promise<void> {
    const existing = this.events.get(event.eventId)

    if (existing !== undefined) {
      if (!sameCombatDecisionTelemetryEvent(existing, event)) {
        return Promise.reject(new CombatDecisionTelemetryConflictError(event.eventId))
      }

      return Promise.resolve()
    }

    this.events.set(event.eventId, event)
    return Promise.resolve()
  }

  async appendMany(events: readonly CombatDecisionTelemetryEvent[]): Promise<void> {
    const results = await Promise.allSettled(events.map((event) => this.append(event)))
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )

    if (failure !== undefined) throw failure.reason
  }

  listDecisionsByBattle(
    origin: CombatDecisionOrigin,
    battleId: string,
  ): Promise<readonly CombatDecisionEvent[]> {
    return Promise.resolve(
      [...this.events.values()]
        .filter(
          (event): event is CombatDecisionEvent =>
            isDecisionEvent(event) && event.origin === origin && event.battleId === battleId,
        )
        .sort((left, right) => left.decisionSequence - right.decisionSequence),
    )
  }

  findOutcome(
    origin: CombatDecisionOrigin,
    battleId: string,
  ): Promise<CombatDecisionOutcomeEvent | null> {
    return Promise.resolve(
      [...this.events.values()].find(
        (event): event is CombatDecisionOutcomeEvent =>
          isOutcomeEvent(event) && event.origin === origin && event.battleId === battleId,
      ) ?? null,
    )
  }
}
