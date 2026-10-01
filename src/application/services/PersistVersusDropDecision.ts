import { BattleRoom } from '../../domain/entities/BattleRoom'
import type {
  BasicAttackResolvedPayload,
  DirectDamageSkillUsedPayload,
  SkillUsedPayload,
} from '../../domain/entities/BattleEvent'
import type { CombatantKey } from '../../domain/entities/Combatant'
import type { VersusDropDecision } from '../../domain/entities/VersusDrop'
import { BattleMode } from '../../domain/value-objects/BattleMode'
import type { BattleDropInventoryPort } from '../ports/BattleDropInventoryPort'
import type { RandomSequencePort } from '../ports/RandomSequencePort'
import { resolveVersusDrop } from './ResolveVersusDrop'

type DamagingPayload = BasicAttackResolvedPayload | SkillUsedPayload | DirectDamageSkillUsedPayload

/**
 * Adhiere el sorteo al MISMO documento/version que el evento de derrota.
 * Una relectura o reconciliación recupera el resultado persistido, jamás
 * vuelve a consumir RNG. El DTO WebSocket existente no serializa este campo.
 */
export class PersistVersusDropDecision {
  constructor(
    private readonly inventory: BattleDropInventoryPort,
    private readonly sequence: RandomSequencePort,
  ) {}

  async execute(previous: BattleRoom, next: BattleRoom, actionSeq: number): Promise<BattleRoom> {
    if (previous.mode !== BattleMode.Pvp) return next
    const action = next.events.find((event) => event.seq === actionSeq)
    if (
      action === undefined ||
      !['basicAttackResolved', 'skillUsed', 'directDamageSkillUsed'].includes(action.type)
    ) return next

    const payload = action.payload as DamagingPayload
    if (payload.targetHealth.before < 1 || payload.targetHealth.after !== 0) return next
    const actor = 'attacker' in payload ? payload.attacker : payload.actor
    const killer = this.participant(previous, actor)
    const defeated = this.participant(previous, payload.target)
    if (
      killer?.playerId === null || killer?.playerId === undefined ||
      defeated?.playerId === null || defeated?.playerId === undefined ||
      actor.teamLabel === payload.target.teamLabel
    ) return next

    const snapshot = await this.inventory.find(previous.id, defeated.playerId)
    const reserved = new Set(
      previous.events.flatMap((event) => {
        const earlier = event.payload as Partial<DamagingPayload>
        const decision = earlier.versusDrop
        return decision?.resolution.status === 'PENDING'
          ? [decision.resolution.selected.productInstanceId]
          : []
      }),
    )
    const resolution = resolveVersusDrop(
      snapshot.equipment.filter((item) => !reserved.has(item.productInstanceId)),
      this.sequence,
    )
    const decision: VersusDropDecision = {
      killerPlayerId: killer.playerId,
      defeatedPlayerId: defeated.playerId,
      resolution,
    }
    const state = next.toSnapshot()
    return BattleRoom.restore({
      ...state,
      events: state.events.map((event) =>
        event.seq === actionSeq
          ? { ...event, payload: { ...event.payload, versusDrop: decision } }
          : event,
      ),
    })
  }

  private participant(room: BattleRoom, key: CombatantKey) {
    return room.battle?.turnOrder.find(
      (entry) => entry.teamLabel === key.teamLabel && entry.seat === key.seat,
    )
  }
}
