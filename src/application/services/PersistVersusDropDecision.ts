import { BattleRoom } from '../../domain/entities/BattleRoom'
import type {
  BasicAttackResolvedPayload,
  DirectDamageSkillUsedPayload,
  EpicUsedPayload,
  SkillUsedPayload,
} from '../../domain/entities/BattleEvent'
import type { CombatantKey } from '../../domain/entities/Combatant'
import type { VersusDropDecision } from '../../domain/entities/VersusDrop'
import { BattleMode } from '../../domain/value-objects/BattleMode'
import type { BattleDropInventoryPort } from '../ports/BattleDropInventoryPort'
import type { RandomSequencePort } from '../ports/RandomSequencePort'
import { resolveVersusDrop } from './ResolveVersusDrop'

/**
 * `EpicUsedPayload` (correccion HU-19/HU-31) se incluye: una epica con un efecto `DAMAGE` puede
 * eliminar a un rival en PvP igual que un ataque basico o una habilidad, y el drop de HU-30 no
 * debe depender de QUE accion causo la derrota. `target`/`targetHealth` son OPCIONALES en ese
 * payload (la mayoria de las epicas no dañan a nadie): se comprueban antes de leerlos.
 */
type DamagingPayload =
  BasicAttackResolvedPayload | SkillUsedPayload | DirectDamageSkillUsedPayload | EpicUsedPayload

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
      !['basicAttackResolved', 'skillUsed', 'directDamageSkillUsed', 'epicUsed'].includes(
        action.type,
      )
    )
      return next

    const payload = action.payload as DamagingPayload
    // `epicUsed` sin dano (la mayoria): sin `targetHealth`/`target`, nada que evaluar.
    if (payload.targetHealth === undefined || payload.target === undefined) return next
    if (payload.targetHealth.before < 1 || payload.targetHealth.after !== 0) return next
    const actor = 'attacker' in payload ? payload.attacker : payload.actor
    const killer = this.participant(previous, actor)
    const defeated = this.participant(previous, payload.target)
    if (
      killer?.playerId === null ||
      killer?.playerId === undefined ||
      defeated?.playerId === null ||
      defeated?.playerId === undefined ||
      actor.teamLabel === payload.target.teamLabel
    )
      return next

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
