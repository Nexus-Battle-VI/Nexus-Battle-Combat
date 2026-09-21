import type { CombatAbility, CombatAbilityEffect } from '../entities/CombatProfile'

/**
 * Que efectos de una habilidad especial sabe ejecutar Combat (HU-19, contrato
 * `hu-19-skills-v1`, §10.2).
 *
 * Catalog v1 puede describir efectos que el documento oficial NO define con precision
 * (duracion, condicion, sanacion, reanimacion, inmunidad, reflejo, efectos sobre el
 * oponente). Se ejecuta UNICAMENTE lo formalmente soportado; lo demas se rechaza de
 * forma explicita: no se aplica a medias ni se descarta en silencio.
 *
 * Una habilidad esta soportada si TODOS sus efectos son un modificador propio de
 * Ataque o de Dano: `STAT_MODIFIER`, `SELF`, `INCREASE`, `ATTACK`/`DAMAGE`, magnitud
 * `FIXED` o `DICE`, sin duracion y sin condicion de activacion. Es el patron «+N (o
 * +NdM) al ataque / al dano» de la Tabla 7 del documento oficial, que la decision
 * confirmada por el PO lee como una mejora de ESA accion (el turno es la accion).
 *
 * Pura y sin E/S: no sortea. Devuelve los bonos agregados para que el caso de uso
 * los resuelva con la secuencia HU-24 en el orden del contrato.
 */
export interface SkillDice {
  readonly count: number
  readonly sides: number
}

/** Bono agregado de una estadistica: la suma de los `FIXED` y los dados en el orden de los efectos. */
export interface SkillBonus {
  readonly fixed: number
  readonly dice: readonly SkillDice[]
}

export type SkillSupport =
  | {
      readonly supported: true
      readonly attackBonus: SkillBonus
      readonly damageBonus: SkillBonus
    }
  | { readonly supported: false; readonly reason: string }

const unsupported = (reason: string): SkillSupport => ({ supported: false, reason })

/** El motivo por el que un efecto no esta soportado, o `null` si lo esta. */
const unsupportedReason = (effect: CombatAbilityEffect): string | null => {
  if (effect.kind !== 'STAT_MODIFIER') {
    return `el efecto ${effect.kind} no tiene una semantica formalmente definida.`
  }

  if (effect.target !== 'SELF') {
    return `un efecto sobre ${effect.target} no esta definido: solo se soportan modificadores propios.`
  }

  if (effect.operation !== 'INCREASE') {
    return 'solo se soporta aumentar la estadistica (INCREASE).'
  }

  if (effect.statistic !== 'ATTACK' && effect.statistic !== 'DAMAGE') {
    return `la estadistica ${String(effect.statistic)} no se soporta: solo Ataque y Dano.`
  }

  if (effect.durationTurns !== undefined) {
    return 'un efecto con duracion exige un estado de batalla mas alla del turno.'
  }

  if (effect.hasActivationCondition) {
    return 'un efecto condicionado no se evalua: la condicion no esta definida formalmente.'
  }

  return null
}

/** Una magnitud usable: entero >= 1, o dados con `count >= 1` y `sides >= 2`. */
const isUsableMagnitude = (effect: CombatAbilityEffect): boolean => {
  const magnitude = effect.magnitude

  if (magnitude?.mode === 'FIXED') {
    return Number.isInteger(magnitude.amount) && magnitude.amount >= 1
  }

  if (magnitude?.mode === 'DICE') {
    return (
      Number.isInteger(magnitude.count) &&
      magnitude.count >= 1 &&
      Number.isInteger(magnitude.sides) &&
      magnitude.sides >= 2
    )
  }

  return false
}

export const evaluateSkill = (ability: CombatAbility): SkillSupport => {
  if (ability.effects.length === 0) {
    return unsupported('la habilidad no declara ningun efecto.')
  }

  const attack = { fixed: 0, dice: [] as SkillDice[] }
  const damage = { fixed: 0, dice: [] as SkillDice[] }

  for (const effect of ability.effects) {
    const reason = unsupportedReason(effect)

    if (reason !== null) {
      return unsupported(reason)
    }

    if (!isUsableMagnitude(effect) || effect.magnitude === undefined) {
      return unsupported('la magnitud del efecto no es un entero >= 1 ni unos dados validos.')
    }

    const bonus = effect.statistic === 'ATTACK' ? attack : damage

    if (effect.magnitude.mode === 'FIXED') {
      bonus.fixed += effect.magnitude.amount
    } else if (effect.magnitude.mode === 'DICE') {
      bonus.dice.push({ count: effect.magnitude.count, sides: effect.magnitude.sides })
    }
  }

  return { supported: true, attackBonus: attack, damageBonus: damage }
}
