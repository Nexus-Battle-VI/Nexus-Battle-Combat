import { MongoServerError, type Collection, type Db } from 'mongodb'

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
  sameCombatDecisionTelemetryEvent,
  toCombatDecisionTelemetryDocument,
  toCombatDecisionTelemetryEvent,
  type CombatDecisionTelemetryDocument,
} from './combat-decision-event-mapping'

export const COMBAT_DECISION_EVENTS_COLLECTION = 'combat-decision-events'

/** Persistencia append-only con `_id = eventId`; un duplicado nunca sobrescribe. */
export class MongoCombatDecisionTelemetryRepository implements CombatDecisionTelemetryRepositoryPort {
  private readonly events: Collection<CombatDecisionTelemetryDocument>

  constructor(db: Db) {
    this.events = db.collection<CombatDecisionTelemetryDocument>(COMBAT_DECISION_EVENTS_COLLECTION)
  }

  async append(event: CombatDecisionTelemetryEvent): Promise<void> {
    try {
      await this.events.insertOne(toCombatDecisionTelemetryDocument(event))
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error

      const stored = await this.events.findOne({ _id: event.eventId })

      if (
        stored === null ||
        !sameCombatDecisionTelemetryEvent(toCombatDecisionTelemetryEvent(stored), event)
      ) {
        throw new CombatDecisionTelemetryConflictError(event.eventId)
      }
    }
  }

  async appendMany(events: readonly CombatDecisionTelemetryEvent[]): Promise<void> {
    const results = await Promise.allSettled(events.map((event) => this.append(event)))
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )

    if (failure !== undefined) throw failure.reason
  }

  async listDecisionsByBattle(
    origin: CombatDecisionOrigin,
    battleId: string,
  ): Promise<readonly CombatDecisionEvent[]> {
    const documents = await this.events
      .find({ eventType: 'COMBAT_DECISION', origin, battleId })
      .sort({ decisionSequence: 1 })
      .toArray()

    return documents.map(toCombatDecisionTelemetryEvent) as CombatDecisionEvent[]
  }

  async findOutcome(
    origin: CombatDecisionOrigin,
    battleId: string,
  ): Promise<CombatDecisionOutcomeEvent | null> {
    const document = await this.events.findOne({
      eventType: 'COMBAT_DECISION_OUTCOME',
      origin,
      battleId,
    })

    return document === null
      ? null
      : (toCombatDecisionTelemetryEvent(document) as CombatDecisionOutcomeEvent)
  }
}
