import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { BattleEvent } from '../../domain/entities/BattleEvent'
import type { VersusDropDecision } from '../../domain/entities/VersusDrop'

export interface BattleDropEvent {
  readonly seq: number
  readonly decision: VersusDropDecision
}

export const battleDropEvents = (room: BattleRoom): readonly BattleDropEvent[] =>
  room.events.flatMap((event: BattleEvent) => {
    // BUG #582: `PersistVersusDropDecision` ya adhiere `versusDrop` tambien a
    // `epicUsed` (una epica con efecto DAMAGE puede ser letal igual que un
    // ataque basico o una habilidad); este filtro debe reconocer exactamente
    // los mismos tipos de evento que esa persistencia, o la decision queda
    // invisible para el scheduler de HU-30.
    if (
      !['basicAttackResolved', 'skillUsed', 'directDamageSkillUsed', 'epicUsed'].includes(
        event.type,
      )
    ) {
      return []
    }
    const decision = (event.payload as { versusDrop?: VersusDropDecision }).versusDrop
    return decision === undefined ? [] : [{ seq: event.seq, decision }]
  })

export const hasPendingVersusDrop = (room: BattleRoom): boolean =>
  battleDropEvents(room).some((event) => event.decision.resolution.status === 'PENDING')
