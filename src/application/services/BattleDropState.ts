import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { BattleEvent } from '../../domain/entities/BattleEvent'
import type { VersusDropDecision } from '../../domain/entities/VersusDrop'

export interface BattleDropEvent {
  readonly seq: number
  readonly decision: VersusDropDecision
}

export const battleDropEvents = (room: BattleRoom): readonly BattleDropEvent[] =>
  room.events.flatMap((event: BattleEvent) => {
    if (!['basicAttackResolved', 'skillUsed', 'directDamageSkillUsed'].includes(event.type)) {
      return []
    }
    const decision = (event.payload as { versusDrop?: VersusDropDecision }).versusDrop
    return decision === undefined ? [] : [{ seq: event.seq, decision }]
  })

export const hasPendingVersusDrop = (room: BattleRoom): boolean =>
  battleDropEvents(room).some((event) => event.decision.resolution.status === 'PENDING')
