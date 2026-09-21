import type {
  BasicAttackResolution,
  BasicAttackResolvedPayload,
  BattleEvent,
  DegradedFrom,
  SkillUsedPayload,
} from '../../domain/entities/BattleEvent'
import type { BattleView } from '../../domain/entities/BattleState'
import type { CombatantKey } from '../../domain/entities/Combatant'

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
  | {
      /** HU-18: un ataque basico resuelto, con la Vida y el turno YA actualizados en `battle`. */
      readonly type: 'basicAttackResolved'
      readonly seq: number
      readonly roomId: string
      readonly occurredAt: string
      readonly commandId: string
      readonly completedPosition: number
      readonly attacker: CombatantKey
      readonly target: CombatantKey
      readonly resolution: BasicAttackResolution
      readonly targetHealth: { readonly before: number; readonly after: number }
      /** HU-19 (opcional): este ataque basico sustituyo a una habilidad por Poder insuficiente. */
      readonly degradedFrom?: DegradedFrom
      readonly battle: BattleView
    }
  | {
      /** HU-19: una habilidad ejecutada, con Vida, Poder, recargas y turno YA actualizados en `battle`. */
      readonly type: 'skillUsed'
      readonly seq: number
      readonly roomId: string
      readonly occurredAt: string
      readonly commandId: string
      readonly completedPosition: number
      readonly actor: SkillUsedPayload['actor']
      readonly target: SkillUsedPayload['target']
      readonly skill: SkillUsedPayload['skill']
      readonly power: SkillUsedPayload['power']
      readonly cooldown: SkillUsedPayload['cooldown']
      readonly bonus: SkillUsedPayload['bonus']
      readonly resolution: BasicAttackResolution
      readonly targetHealth: { readonly before: number; readonly after: number }
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

  if (event.type === 'basicAttackResolved') {
    const attack = event.payload as BasicAttackResolvedPayload

    return {
      type: 'basicAttackResolved',
      seq: event.seq,
      roomId,
      occurredAt,
      commandId: attack.commandId,
      completedPosition: attack.completedPosition,
      attacker: attack.attacker,
      target: attack.target,
      resolution: attack.resolution,
      targetHealth: attack.targetHealth,
      ...(attack.degradedFrom === undefined ? {} : { degradedFrom: attack.degradedFrom }),
      battle: attack.battle,
    }
  }

  if (event.type === 'skillUsed') {
    const skill = event.payload as SkillUsedPayload

    return {
      type: 'skillUsed',
      seq: event.seq,
      roomId,
      occurredAt,
      commandId: skill.commandId,
      completedPosition: skill.completedPosition,
      actor: skill.actor,
      target: skill.target,
      skill: skill.skill,
      power: skill.power,
      cooldown: skill.cooldown,
      bonus: skill.bonus,
      resolution: skill.resolution,
      targetHealth: skill.targetHealth,
      battle: skill.battle,
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
