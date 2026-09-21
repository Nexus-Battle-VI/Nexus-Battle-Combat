import { AttackNotDefinedError } from '../../domain/errors/AttackResolutionErrors'
import { attackDiceFor, type AttackProfile } from '../../domain/policies/AttackProfile'
import type { EffectControlTable } from '../../domain/random-effects/EffectControlTable'
import type { EquippedHero } from '../ports/PlayerInventoryEquippedHeroPort'
import {
  assessEquipmentEffect,
  buildHeroEffectTable,
  type EquipmentEffectAssessment,
  type HeroEffectTable,
} from './BuildHeroEffectTable'

/**
 * Todo lo que `ResolveAttack` necesita de UN golpe entre dos heroes, mas la
 * clasificacion de sus efectos para poder auditar que se aplico y que no.
 */
export interface PreparedAttack {
  /** Ataque del atacante: su valor efectivo menos lo que le resta el equipo del objetivo, y su dado. */
  readonly attack: AttackProfile
  /** Defensa efectiva del objetivo (`effectiveStats.defense`). */
  readonly defenseValue: number
  /** Tabla del atacante para ESTE golpe: la de `attackerEffects` menos el critico que le quita el objetivo. */
  readonly table: EffectControlTable
  /** Tabla base, incrementos propios y efectos pendientes del ATACANTE. */
  readonly attackerEffects: HeroEffectTable
  /** Efectos del OBJETIVO, clasificados; los `AFFECTS_ATTACKERS` ya estan aplicados a `attack` y `table`. */
  readonly targetEffects: readonly EquipmentEffectAssessment[]
}

/**
 * De dos heroes equipados a un golpe listo para resolverse (HU-20, RF-20).
 *
 *   atacante  ->  Ataque efectivo (arma, items, armaduras: ya en `effectiveStats`)
 *                 + dado de Ataque de su subtipo (Tabla 6)
 *                 + tabla de efectos propia (`buildHeroEffectTable`)
 *   objetivo  ->  Defensa efectiva
 *                 + lo que su equipo le quita al atacante (`AFFECTS_ATTACKERS`)
 *
 * CA-02 y CA-03: el Ataque y la Defensa son las ESTADISTICAS EFECTIVAS de
 * Player-Inventory (base mas modificadores permanentes), sin volver a sumar los
 * efectos `appliedToStats`. Se le AGREGA lo que el equipo del objetivo le resta
 * al atacante, que el documento define y Player-Inventory no puede consolidar
 * porque depende de con quien se pelee: «-1 al ataque del oponente» y «-2 % de
 * critico al ataque del oponente». «Oponente» se lee como el heroe que ataca al
 * portador: el efecto se aplica cuando el portador es el objetivo del golpe.
 * Contra el Ataque, la resta se acota en 0 igual que Player-Inventory acota las
 * estadisticas efectivas (un Ataque no es negativo); contra la tabla, el critico
 * no baja de 0 filas y lo que pierde vuelve a «no causar dano».
 *
 * Lo que NO hace, y por que:
 *  - No evalua efectos condicionados ni temporales (habilidades y epicas, «+1 al
 *    dano por dos turnos»): necesitan el estado de la batalla (turnos, contador
 *    de recarga) que Combat aun no tiene (HU-17, HU-18, HU-19). Quedan en
 *    `pendingEffects` de cada heroe, no aplicados.
 *  - No valida turnos, equipos ni fuego amigo (HU-12, HU-17, HU-18).
 *
 * Falla de forma explicita: subtipo fuera de `hero-subtypes-v1` (`DomainError`),
 * atacante sin Ataque numerico (`AttackNotDefinedError`: sanadores, o un Ataque
 * declarado como dado en Catalog) y critico propio que supera el «no causar
 * dano» disponible (`InsufficientNoDamageProbabilityError`).
 *
 * Pura y sin E/S: no toca la aleatoriedad (HU-24); solo prepara los datos.
 */
export const prepareAttack = (attacker: EquippedHero, target: EquippedHero): PreparedAttack => {
  const attackerEffects = buildHeroEffectTable(attacker)
  const effectiveAttack = attacker.effectiveStats.attack

  if (effectiveAttack === null) {
    throw new AttackNotDefinedError(attackerEffects.subtype)
  }

  const targetEffects = target.activeEffects.map(assessEquipmentEffect)
  const adjustments = targetEffects.flatMap(({ adjustment }) =>
    adjustment === undefined ? [] : [adjustment],
  )
  const attackReduction = adjustments.reduce(
    (total, adjustment) => (adjustment.statistic === 'ATTACK' ? total + adjustment.points : total),
    0,
  )
  const criticalReductions = adjustments.flatMap((adjustment) =>
    adjustment.statistic === 'CRITICAL_CHANCE' ? [adjustment.reduction] : [],
  )

  return {
    attack: {
      base: Math.max(0, effectiveAttack - attackReduction),
      dice: attackDiceFor(attackerEffects.subtype),
    },
    defenseValue: target.effectiveStats.defense,
    table: attackerEffects.table.withReductions(criticalReductions),
    attackerEffects,
    targetEffects,
  }
}
