import { resolveLegalAction } from '../../domain/decision/ActionIdentity'
import type { ActionIntent } from '../../domain/decision/ActionIntent'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import {
  COMBAT_END_TURN_DECISION_EVENT_SCHEMA_VERSION,
  COMBAT_DECISION_EVENT_SCHEMA_VERSION,
  decisionOutcomeEventId,
  missionDecisionEventId,
  onlineDecisionEventId,
  type CombatDecisionEvent,
  type CombatDecisionOrigin,
  type CombatDecisionOutcome,
  type CombatDecisionOutcomeEvent,
  type CombatDecisionSource,
  type CombatDecisionSelection,
  type CombatDecisionTelemetryEvent,
} from '../../domain/decision/CombatDecisionEvent'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { CombatantKey } from '../../domain/entities/Combatant'
import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { BattleMode } from '../../domain/value-objects/BattleMode'
import type { ClockPort } from '../ports/ClockPort'
import type { CommandIdFingerprintPort } from '../ports/CommandIdFingerprintPort'
import type { CombatDecisionTelemetryRepositoryPort } from '../ports/CombatDecisionTelemetryRepositoryPort'
import { BattleDecisionStateAssembler } from './BattleDecisionStateAssembler'
import { LegalActionGenerator } from './LegalActionGenerator'
import { IllegalActionIntentError } from '../../domain/errors/DecisionContractErrors'

export interface CombatDecisionRecorderLogger {
  error(message: string, context?: Readonly<Record<string, string | number>>): void
}

export interface DecisionDraft {
  readonly eventId: string
  readonly battleId: string
  readonly decisionSequence: number
  readonly origin: CombatDecisionOrigin
  readonly mode: BattleMode
  readonly actor: CombatantKey
  readonly decisionSource: CombatDecisionSource
  readonly stateBefore: BattleDecisionState
  readonly legalActions: readonly LegalAction[]
  readonly selectedAction: CombatDecisionSelection
}

export type OutcomeDraft = Omit<
  CombatDecisionOutcomeEvent,
  'schemaVersion' | 'eventType' | 'occurredAt'
>

/**
 * Construye eventos antes de mutar y los persiste después del agregado/resultado.
 * Las escrituras son fail-open: la telemetría jamás cambia el resultado del combate.
 */
export class CombatDecisionRecorder {
  constructor(
    private readonly repository: CombatDecisionTelemetryRepositoryPort,
    private readonly clock: ClockPort,
    private readonly logger: CombatDecisionRecorderLogger,
    private readonly commandIds: CommandIdFingerprintPort,
    private readonly states: BattleDecisionStateAssembler = new BattleDecisionStateAssembler(),
    private readonly actions: LegalActionGenerator = new LegalActionGenerator(),
  ) {}

  /** Captura el snapshot autoritativo antes de cualquier mutación o consumo de RNG. */
  prepareHumanDecision(
    room: BattleRoom,
    commandId: string,
    selectedAction: ActionIntent,
  ): CombatDecisionEvent {
    const stateBefore = this.states.assemble(room)
    const legalActions = this.actions.generate(room)

    return this.prepareOnline({
      commandId,
      battleId: room.id,
      decisionSequence: stateBefore.context.turnsCompleted,
      origin: room.tournament === null ? 'ONLINE' : 'TOURNAMENT',
      mode: room.mode,
      actor: stateBefore.actor.identity,
      decisionSource: 'HUMAN',
      stateBefore,
      legalActions,
      selectedAction,
    })
  }

  tryPrepareHumanDecision(
    room: BattleRoom,
    commandId: string,
    selectedAction: ActionIntent,
  ): CombatDecisionEvent | null {
    try {
      return this.prepareHumanDecision(room, commandId, selectedAction)
    } catch (error: unknown) {
      this.logPreparationFailure(room.id, room.tournament === null ? 'ONLINE' : 'TOURNAMENT', error)
      return null
    }
  }

  prepareOnline(
    input: Omit<DecisionDraft, 'eventId'> & { readonly commandId: string },
  ): CombatDecisionEvent {
    const origin = input.origin === 'TOURNAMENT' ? 'TOURNAMENT' : 'ONLINE'

    return this.prepare({
      ...input,
      origin,
      eventId: onlineDecisionEventId(
        origin,
        input.battleId,
        this.commandIds.fingerprint(input.commandId),
      ),
    })
  }

  tryPrepareOnline(
    input: Omit<DecisionDraft, 'eventId'> & { readonly commandId: string },
  ): CombatDecisionEvent | null {
    try {
      return this.prepareOnline(input)
    } catch (error: unknown) {
      this.logPreparationFailure(input.battleId, input.origin, error)
      return null
    }
  }

  prepareMission(input: Omit<DecisionDraft, 'eventId' | 'origin'>): CombatDecisionEvent {
    return this.prepare({
      ...input,
      origin: 'MISSION',
      eventId: missionDecisionEventId(input.battleId, input.decisionSequence),
    })
  }

  tryPrepareMission(input: Omit<DecisionDraft, 'eventId' | 'origin'>): CombatDecisionEvent | null {
    try {
      return this.prepareMission(input)
    } catch (error: unknown) {
      this.logPreparationFailure(input.battleId, 'MISSION', error)
      return null
    }
  }

  prepare(input: DecisionDraft): CombatDecisionEvent {
    const endTurn = input.selectedAction.kind === 'END_TURN'

    if (endTurn && (input.legalActions.length !== 0 || input.decisionSource !== 'SYSTEM')) {
      throw new IllegalActionIntentError()
    }

    const selectedAction = endTurn
      ? Object.freeze({ kind: 'END_TURN' as const })
      : resolveLegalAction(input.selectedAction, input.legalActions)

    return Object.freeze({
      schemaVersion: endTurn
        ? COMBAT_END_TURN_DECISION_EVENT_SCHEMA_VERSION
        : COMBAT_DECISION_EVENT_SCHEMA_VERSION,
      eventType: 'COMBAT_DECISION' as const,
      eventId: input.eventId,
      battleId: input.battleId,
      decisionSequence: input.decisionSequence,
      origin: input.origin,
      mode: input.mode,
      actor: Object.freeze({ ...input.actor }),
      decisionSource: input.decisionSource,
      stateBefore: input.stateBefore,
      legalActions: input.legalActions,
      selectedAction,
      occurredAt: this.clock.now(),
    })
  }

  prepareOutcome(input: {
    readonly origin: CombatDecisionOrigin
    readonly battleId: string
    readonly mode: BattleMode
    readonly outcome: CombatDecisionOutcome
    readonly occurredAt?: Date
  }): CombatDecisionOutcomeEvent {
    return Object.freeze({
      schemaVersion: COMBAT_DECISION_EVENT_SCHEMA_VERSION,
      eventType: 'COMBAT_DECISION_OUTCOME' as const,
      eventId: decisionOutcomeEventId(input.origin, input.battleId),
      battleId: input.battleId,
      origin: input.origin,
      mode: input.mode,
      outcome: Object.freeze({ ...input.outcome }),
      occurredAt: input.occurredAt ?? this.clock.now(),
    })
  }

  tryPrepareOutcome(input: {
    readonly origin: CombatDecisionOrigin
    readonly battleId: string
    readonly mode: BattleMode
    readonly outcome: CombatDecisionOutcome
    readonly occurredAt?: Date
  }): CombatDecisionOutcomeEvent | null {
    try {
      return this.prepareOutcome(input)
    } catch (error: unknown) {
      this.logPreparationFailure(input.battleId, input.origin, error)
      return null
    }
  }

  async record(event: CombatDecisionTelemetryEvent): Promise<void> {
    try {
      await this.repository.append(event)
    } catch (error: unknown) {
      this.logFailure(event, error)
    }
  }

  async recordMany(events: readonly CombatDecisionTelemetryEvent[]): Promise<void> {
    // Cada evento es fail-open de forma independiente: una escritura fallida no
    // impide intentar las decisiones posteriores ni el outcome terminal.
    for (const event of events) await this.record(event)
  }

  private logFailure(event: CombatDecisionTelemetryEvent, error: unknown, eventCount = 1): void {
    this.logger.error('combat_decision_telemetry_append_failed', {
      eventId: event.eventId,
      battleId: event.battleId,
      origin: event.origin,
      eventCount,
      reason: error instanceof Error ? error.name : 'unknown',
    })
  }

  private logPreparationFailure(
    battleId: string,
    origin: CombatDecisionOrigin,
    error: unknown,
  ): void {
    this.logger.error('combat_decision_telemetry_prepare_failed', {
      battleId,
      origin,
      reason: error instanceof Error ? error.name : 'unknown',
    })
  }
}
