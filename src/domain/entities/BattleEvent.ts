import type { BattleResult } from './BattleResult'
import type { BattleView } from './BattleState'
import type { CombatantKey } from './Combatant'
import type { CombatPowerCost } from './CombatProfile'

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
  /** HU-19: una habilidad especial ejecutada, con el estado YA avanzado (un solo `seq` por accion). */
  SkillUsed: 'skillUsed',
  /** HU-21: el turno vigente vencio sin accion y paso al siguiente participante con Vida. */
  TurnTimedOut: 'turnTimedOut',
  /** HU-21: la batalla termino; lleva el resultado unico y la vista FINAL sin `deadlines`. */
  BattleFinished: 'battleFinished',
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
 * El turno vigente vencio sin accion (HU-21, contrato §6.1): se cerro sin
 * resolver nada, el avance salta a los participantes con Vida y arranca su
 * temporizador. NO finaliza la batalla.
 */
export interface TurnTimedOutPayload {
  /** Posicion (0-based) del turno que se perdio. */
  readonly completedPosition: number
  /** Quien perdio el turno. */
  readonly timedOut: CombatantKey
  /** Vista POSTERIOR: turno ya avanzado y `deadlines` nuevos. */
  readonly battle: BattleView
}

/**
 * La batalla termino (HU-21, contrato §6.2): resultado unico y vista FINAL
 * (Vida final, Poder restaurado al maximo, SIN `deadlines`). Tras este evento
 * no hay mas eventos en la sala.
 */
export interface BattleFinishedPayload {
  readonly result: BattleResult
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

/**
 * Un `useSkill` que se degrado a ataque basico porque el Poder no alcanzaba (HU-11:
 * «el sistema debe forzar el uso del ataque basico en ese turno»). Solo existe en un
 * `basicAttackResolved` que viene de una habilidad; un ataque normal no lo lleva.
 */
export interface DegradedFrom {
  readonly command: 'useSkill'
  readonly abilityId: string
  readonly reason: 'INSUFFICIENT_POWER'
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
  /** HU-19 (opcional): por que este ataque basico sustituyo a una habilidad. */
  readonly degradedFrom?: DegradedFrom
  /** Vista POSTERIOR: Vida actualizada y turno ya avanzado. */
  readonly battle: BattleView
}

/**
 * Resultado de una habilidad especial (HU-19, contrato `hu-19-skills-v1` §6.1). Trae el
 * resultado del golpe, lo que aporto la habilidad, el Poder y la recarga, y la vista
 * POSTERIOR. No viajan los efectos de la habilidad, el dado de Ataque por separado, los
 * indices sorteados ni la semilla.
 */
export interface SkillUsedPayload {
  readonly commandId: string
  readonly completedPosition: number
  readonly actor: CombatantKey
  readonly target: CombatantKey
  readonly skill: {
    readonly abilityId: string
    readonly name: string
    readonly powerCost: CombatPowerCost
    readonly chargeTurns: number
  }
  /** Poder del actor antes y despues de pagar el costo. */
  readonly power: { readonly before: number; readonly after: number }
  /** Turnos propios que le faltan a ESTA habilidad tras la accion. */
  readonly cooldown: { readonly remainingTurns: number }
  /** Lo que aporto la habilidad. `damage` es `null` si no se tiro (golpe no efectivo o efecto 0 %). */
  readonly bonus: { readonly attack: number; readonly damage: number | null }
  readonly resolution: BasicAttackResolution
  readonly targetHealth: { readonly before: number; readonly after: number }
  /** Vista POSTERIOR: Vida, Poder, recargas y turno ya avanzado. */
  readonly battle: BattleView
}

export interface BattleEvent {
  readonly seq: number
  readonly type: BattleEventType
  readonly occurredAt: Date
  readonly payload:
    | BattleStartedPayload
    | TurnAdvancedPayload
    | BasicAttackResolvedPayload
    | SkillUsedPayload
    | TurnTimedOutPayload
    | BattleFinishedPayload
}

/** Comando ya procesado (ADR-020: repetir un `commandId` no ejecuta dos veces). */
export interface HandledCommand {
  readonly commandId: string
  readonly seq: number
}
