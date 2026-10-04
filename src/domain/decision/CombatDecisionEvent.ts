import type { BattleDecisionState } from './BattleDecisionState'
import type { ActionIntent } from './ActionIntent'
import type { LegalAction } from './LegalAction'
import type { CombatantKey } from '../entities/Combatant'
import type { BattleFinishReason, BattleOutcome } from '../entities/BattleResult'
import type { BattleMode } from '../value-objects/BattleMode'

export const COMBAT_DECISION_EVENT_SCHEMA_VERSION = 1 as const

export type CombatDecisionOrigin = 'ONLINE' | 'MISSION' | 'TOURNAMENT'
export type CombatDecisionSource = 'HUMAN' | 'RULE_BASED' | 'RANDOM' | 'MCTS' | 'NEURAL'

/**
 * Hecho append-only que describe exactamente lo que una política pudo observar y elegir.
 * No contiene identidad personal, estado del RNG ni el resultado posterior de la acción.
 */
export interface CombatDecisionEvent {
  readonly schemaVersion: typeof COMBAT_DECISION_EVENT_SCHEMA_VERSION
  readonly eventType: 'COMBAT_DECISION'
  readonly eventId: string
  readonly battleId: string
  readonly decisionSequence: number
  readonly origin: CombatDecisionOrigin
  readonly mode: BattleMode
  readonly actor: CombatantKey
  readonly decisionSource: CombatDecisionSource
  readonly stateBefore: BattleDecisionState
  readonly legalActions: readonly LegalAction[]
  readonly selectedAction: ActionIntent
  readonly occurredAt: Date
}

export type CombatDecisionOutcome =
  | {
      readonly kind: 'BATTLE'
      readonly reason: BattleFinishReason
      readonly outcome: BattleOutcome
      readonly winnerTeamLabel: string | null
    }
  | {
      readonly kind: 'MISSION'
      readonly outcome: 'HERO_VICTORIOUS' | 'HERO_DEFEATED' | 'TIME_BUDGET_EXHAUSTED'
    }

/** Resultado terminal separado: las decisiones nunca se actualizan retrospectivamente. */
export interface CombatDecisionOutcomeEvent {
  readonly schemaVersion: typeof COMBAT_DECISION_EVENT_SCHEMA_VERSION
  readonly eventType: 'COMBAT_DECISION_OUTCOME'
  readonly eventId: string
  readonly battleId: string
  readonly origin: CombatDecisionOrigin
  readonly mode: BattleMode
  readonly outcome: CombatDecisionOutcome
  readonly occurredAt: Date
}

export type CombatDecisionTelemetryEvent = CombatDecisionEvent | CombatDecisionOutcomeEvent

const component = (value: string): string => `${String(value.length)}:${value}`

/** `commandId` queda encapsulado en la identidad técnica; no se expone como feature. */
export const onlineDecisionEventId = (
  origin: Extract<CombatDecisionOrigin, 'ONLINE' | 'TOURNAMENT'>,
  battleId: string,
  commandId: string,
): string => `decision:${origin}:${component(battleId)}:${component(commandId)}`

export const missionDecisionEventId = (battleId: string, decisionSequence: number): string =>
  `decision:MISSION:${component(battleId)}:${String(decisionSequence)}`

export const decisionOutcomeEventId = (origin: CombatDecisionOrigin, battleId: string): string =>
  `outcome:${origin}:${component(battleId)}`
