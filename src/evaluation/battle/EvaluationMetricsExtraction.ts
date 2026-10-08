import {
  BattleEventType,
  type BattleEvent,
  type DirectDamageSkillUsedPayload,
  type EpicUsedPayload,
  type HealSkillUsedPayload,
  type SkillUsedPayload,
  type BasicAttackResolvedPayload,
} from '../../domain/entities/BattleEvent'
import type { CombatantKey } from '../../domain/entities/Combatant'

/**
 * Extraccion de daño/curacion/Poder sobre `BattleEvent` REALES (EN-036.5,
 * Management #569 §48-53): nunca "damage teorico" ni magnitud base, SIEMPRE
 * `appliedDamage`/`heal.amount` ya acotados por el motor. Auditado contra
 * CADA tipo de evento con payload de daño/curacion (#569 §49): ataque
 * basico, habilidad, daño directo, epica; reflect NO es un evento propio
 * (se pliega en `resolution`/`bonus` del siguiente ataque del atacante) y
 * por tanto NO es atribuible como categoria separada -- se documenta en
 * `docs/en-036-ai-evaluation.md`, nunca se inventa una atribucion que el
 * evento no sustenta (#569 §50).
 */

export interface DamageAttribution {
  readonly attacker: CombatantKey
  readonly target: CombatantKey
  readonly amount: number
}

export interface HealAttribution {
  readonly actor: CombatantKey
  /** Uno o mas objetivos; cada uno recibe EXACTAMENTE `amountPerTarget` (#569 §50: nunca "el mismo total repartido"). */
  readonly targets: readonly CombatantKey[]
  readonly amountPerTarget: number
}

export interface PowerAfterAttribution {
  readonly actor: CombatantKey
  readonly after: number
}

/** `null` si el evento no transporta daño atribuible (p. ej. curacion, fin de turno). */
export const extractDamage = (event: BattleEvent): DamageAttribution | null => {
  switch (event.type) {
    case BattleEventType.BasicAttackResolved: {
      const payload = event.payload as BasicAttackResolvedPayload
      return {
        attacker: payload.attacker,
        target: payload.target,
        amount: payload.resolution.appliedDamage,
      }
    }
    case BattleEventType.SkillUsed: {
      const payload = event.payload as SkillUsedPayload
      return {
        attacker: payload.actor,
        target: payload.target,
        amount: payload.resolution.appliedDamage,
      }
    }
    case BattleEventType.DirectDamageSkillUsed: {
      const payload = event.payload as DirectDamageSkillUsedPayload
      return {
        attacker: payload.actor,
        target: payload.target,
        amount: payload.damage.appliedDamage,
      }
    }
    case BattleEventType.EpicUsed: {
      const payload = event.payload as EpicUsedPayload
      if (payload.damage === undefined || payload.target === undefined) {
        return null
      }
      return {
        attacker: payload.actor,
        target: payload.target,
        amount: payload.damage.appliedDamage,
      }
    }
    default:
      return null
  }
}

/** `null` si el evento no transporta curacion (categoria distinta de daño, #569 §50). */
export const extractHeal = (event: BattleEvent): HealAttribution | null => {
  switch (event.type) {
    case BattleEventType.HealSkillUsed: {
      const payload = event.payload as HealSkillUsedPayload
      return {
        actor: payload.actor,
        targets: payload.affected ?? [payload.target],
        amountPerTarget: payload.heal.amount,
      }
    }
    case BattleEventType.EpicUsed: {
      const payload = event.payload as EpicUsedPayload
      if (payload.heal === undefined) {
        return null
      }
      const targets = payload.affected ?? (payload.target === undefined ? [] : [payload.target])
      return { actor: payload.actor, targets, amountPerTarget: payload.heal.amount }
    }
    default:
      return null
  }
}

/**
 * `null` si el evento no paga Poder (p. ej. `basicAttackResolved`, que es
 * gratuito). El Poder PRE-terminal del actor que ejecuto la accion (#569
 * §52-53): el llamador debe acumular esto en un tracker propio y NUNCA
 * leer Poder de una sala `FINISHED` (`BattleRoom.finish()` ejecuta
 * `restoreAllPower()` antes de devolverla).
 */
export const extractPowerAfter = (event: BattleEvent): PowerAfterAttribution | null => {
  switch (event.type) {
    case BattleEventType.SkillUsed:
    case BattleEventType.HealSkillUsed:
    case BattleEventType.DirectDamageSkillUsed:
    case BattleEventType.EpicUsed: {
      const payload = event.payload as
        SkillUsedPayload | HealSkillUsedPayload | DirectDamageSkillUsedPayload | EpicUsedPayload
      return { actor: payload.actor, after: payload.power.after }
    }
    default:
      return null
  }
}
