import type { BattleView } from './BattleState'

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

export interface BattleEvent {
  readonly seq: number
  readonly type: BattleEventType
  readonly occurredAt: Date
  readonly payload: BattleStartedPayload | TurnAdvancedPayload
}

/** Comando ya procesado (ADR-020: repetir un `commandId` no ejecuta dos veces). */
export interface HandledCommand {
  readonly commandId: string
  readonly seq: number
}
