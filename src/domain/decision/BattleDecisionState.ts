import type { CombatantKey } from '../entities/Combatant'
import type { ParticipantKind } from '../entities/Participant'
import type { CombatPowerCost } from '../entities/CombatProfile'
import type { BattleMode } from '../value-objects/BattleMode'

export interface DecisionHealth {
  readonly current: number
  readonly max: number
}

export interface DecisionPower {
  readonly current: number
  readonly max: number
}

export interface DecisionCooldown {
  readonly abilityId: string
  readonly remainingOwnTurns: number
}

export interface DecisionAbility {
  readonly abilityId: string
  readonly powerCost: CombatPowerCost
  readonly chargeTurns: number
}

export interface DecisionEpic {
  readonly epicId: string
  readonly powerCost: number
  readonly cooldownTurns: number
  readonly cooldownRemaining: number
}

export type DecisionActiveEffect =
  | {
      readonly kind: 'STAT'
      readonly statistic: string
      readonly operation: string
      readonly amount: number
      readonly remainingOwnTurns: number
    }
  | { readonly kind: 'IMMUNITY'; readonly immunityCode: string; readonly remainingOwnTurns: number }

/** Vista semántica mínima del snapshot de Combat; nunca incluye identidad personal ni RNG. */
export interface DecisionCombatant {
  readonly identity: CombatantKey
  readonly kind: ParticipantKind
  readonly heroSubtype: string | null
  readonly health: DecisionHealth | null
  readonly power: DecisionPower | null
  readonly attack: number | null
  readonly defense: number | null
  readonly cooldowns: readonly DecisionCooldown[]
  readonly abilities: readonly DecisionAbility[]
  readonly epic: DecisionEpic | null
  readonly activeEffects: readonly DecisionActiveEffect[]
  readonly damageMemory: { readonly amount: number; readonly remainingOwnTurns: number } | null
}

/** Contrato versionado de observación para políticas y telemetría futura. */
export interface BattleDecisionState {
  readonly schemaVersion: 1
  readonly context: {
    readonly battleId: string
    readonly mode: BattleMode
    readonly round: number
    readonly turnsCompleted: number
  }
  readonly actor: DecisionCombatant
  readonly allies: readonly DecisionCombatant[]
  readonly enemies: readonly DecisionCombatant[]
}
