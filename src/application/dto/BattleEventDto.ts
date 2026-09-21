import type { BattleEvent } from '../../domain/entities/BattleEvent'
import type { BattleView } from '../../domain/entities/BattleState'

/**
 * Forma en el cable de un evento de batalla (HU-17, contrato v1 de
 * Infrastructure): `{ type, seq, roomId, occurredAt, ...payload }`. Es
 * IDENTICA para todos los participantes: la construye el servidor una vez y se
 * persiste tal cual, asi que un `resume` reenvia exactamente lo mismo.
 */
export type BattleEventWire =
  | {
      readonly type: 'battleStarted'
      readonly seq: number
      readonly roomId: string
      readonly occurredAt: string
      readonly battle: BattleView
    }
  | {
      readonly type: 'turnAdvanced'
      readonly seq: number
      readonly roomId: string
      readonly occurredAt: string
      readonly completedPosition: number
      readonly battle: BattleView
    }

export const toBattleEventWire = (roomId: string, event: BattleEvent): BattleEventWire => {
  const occurredAt = event.occurredAt.toISOString()

  if (event.type === 'battleStarted') {
    return {
      type: 'battleStarted',
      seq: event.seq,
      roomId,
      occurredAt,
      battle: event.payload.battle,
    }
  }

  const payload = event.payload as { completedPosition: number; battle: BattleView }

  return {
    type: 'turnAdvanced',
    seq: event.seq,
    roomId,
    occurredAt,
    completedPosition: payload.completedPosition,
    battle: payload.battle,
  }
}

/** Instantanea del estado visible (respuesta de `resume` cuando no hay replay). */
export interface BattleSnapshotWire {
  readonly type: 'snapshot'
  readonly roomId: string
  readonly seq: number
  readonly status: string
  readonly battle: BattleView | null
}
