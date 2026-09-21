import type { BattleView } from './BattleState'
import type { CombatantKey } from './Combatant'

/**
 * Eventos de batalla con numero de secuencia (ADR-020, HU-17). `seq` es un
 * entero creciente POR SALA, empieza en 1 (`battleStarted` = 1) y no tiene
 * huecos: el orden entre eventos es total.
 *
 * `payload.battle` es la vista visible YA CALCULADA en el momento del evento:
 * lo que se persiste es exactamente lo que reciben todos los clientes (y lo
 * que se reenvia en un `resume`), sin recalcularlo despues.
 */
export const BattleEventType = {
  BattleStarted: 'battleStarted',
  TurnAdvanced: 'turnAdvanced',
  /** HU-18: un ataque basico resuelto, con el estado YA avanzado (un solo `seq` por accion). */
  BasicAttackResolved: 'basicAttackResolved',
} as const

export type BattleEventType = (typeof BattleEventType)[keyof typeof BattleEventType]

export interface BattleStartedPayload {
  readonly battle: BattleView
}

export interface TurnAdvancedPayload {
  /** Posicion (0-based) del turno que acaba de cerrarse. */
  readonly completedPosition: number
  readonly battle: BattleView
}

/**
 * Resultado de un ataque basico (HU-18, contrato v1). Solo lo que explica el golpe:
 * `attackValue` contra `defenseValue`, el efecto y su porcentaje, y el dano en sus
 * tres etapas. No viajan el dado de Ataque por separado, los efectos, las
 * estadisticas, el indice sorteado ni la semilla.
 */
export interface BasicAttackResolution {
  /** Ataque final (base + dado) que se comparo con la Defensa. */
  readonly attackValue: number
  readonly defenseValue: number
  readonly effective: boolean
  /** `RandomEffectType` o `null` si el golpe no fue efectivo. */
  readonly effect: string | null
  /** Porcentaje entero 0..180, o `null` si el golpe no fue efectivo. */
  readonly percent: number | null
  /** Dano base materializado, o `null` si no se tiro (golpe no efectivo o efecto 0 % con dados). */
  readonly baseDamage: number | null
  /** `floor(dano base x porcentaje / 100)`. */
  readonly calculatedDamage: number
  /** `min(dano calculado, Vida antes)`. */
  readonly appliedDamage: number
}

export interface BasicAttackResolvedPayload {
  /** El `commandId` del atacante: permite al remitente correlacionar su comando. */
  readonly commandId: string
  /** Posicion (0-based) del turno que acaba de cerrarse. */
  readonly completedPosition: number
  readonly attacker: CombatantKey
  readonly target: CombatantKey
  readonly resolution: BasicAttackResolution
  readonly targetHealth: { readonly before: number; readonly after: number }
  /** Vista POSTERIOR: Vida actualizada y turno ya avanzado. */
  readonly battle: BattleView
}

export interface BattleEvent {
  readonly seq: number
  readonly type: BattleEventType
  readonly occurredAt: Date
  readonly payload: BattleStartedPayload | TurnAdvancedPayload | BasicAttackResolvedPayload
}

/** Comando ya procesado (ADR-020: repetir un `commandId` no ejecuta dos veces). */
export interface HandledCommand {
  readonly commandId: string
  readonly seq: number
}
