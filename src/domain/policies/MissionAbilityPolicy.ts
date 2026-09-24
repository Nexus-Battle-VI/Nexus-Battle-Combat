import type { CombatAbility, CombatAbilityEffect, CombatMagnitude } from '../entities/CombatProfile'
import type { SkillBonus, SkillDice } from './SkillEffectPolicy'

/**
 * Semantica de las habilidades DENTRO de una mision (diseno «misiones jugables»,
 * P-J4). Es propia del modo mision: `evaluateSkill` sigue siendo la puerta de las
 * batallas PvP y no cambia.
 *
 * En una mision el heroe pelea solo, asi que «aliado» y «grupo aliado» son el
 * propio heroe. Un efecto con condicion de activacion no se evalua: Combat solo
 * recibe que existe una condicion, no cual es.
 */
export type MissionStatistic = 'ATTACK' | 'DAMAGE' | 'DEFENSE'

export type MissionEffect =
  /**
   * Modificador con duracion: `turns` rondas contando la del uso. Sobre `SELF`
   * sube la estadistica del heroe; sobre `OPPONENT` la baja al enemigo actual.
   */
  | {
      readonly kind: 'MODIFIER'
      readonly target: 'SELF' | 'OPPONENT'
      readonly statistic: MissionStatistic
      readonly amount: SkillBonus
      readonly turns: number
    }
  /** Dano al enemigo sin tirada de ataque (como el dano directo de PvP). */
  | { readonly kind: 'DIRECT_DAMAGE'; readonly amount: SkillBonus }
  /** Curacion ahora y, si `turns > 1`, al empezar cada una de las rondas siguientes. */
  | { readonly kind: 'HEAL'; readonly amount: SkillBonus; readonly turns: number }
  /** Curacion por porcentaje de la vida maxima (la Reanimacion de PvP). */
  | { readonly kind: 'HEAL_PERCENT'; readonly basisPoints: number }
  /** El heroe no recibe dano durante `turns` rondas. */
  | { readonly kind: 'IMMUNITY'; readonly turns: number }
  /** Resta ese porcentaje del dano recibido y se lo devuelve al atacante. */
  | { readonly kind: 'REFLECT'; readonly basisPoints: number; readonly turns: number }

export type MissionAbilitySupport =
  | {
      readonly supported: true
      /** Si la habilidad incluye un ataque (tirada de d20) este turno. */
      readonly attacks: boolean
      /** Bonificaciones al ataque y al dano solo de este turno, como en `evaluateSkill`. */
      readonly attackBonus: SkillBonus
      readonly damageBonus: SkillBonus
      readonly effects: readonly MissionEffect[]
    }
  | { readonly supported: false; readonly reason: string }

const MAX_BASIS_POINTS = 10_000

const unsupported = (reason: string): MissionAbilitySupport => ({ supported: false, reason })

/** Una magnitud entera o de dados como bonificacion; `null` si no lo es. */
const bonusOf = (magnitude: CombatMagnitude | undefined): SkillBonus | null => {
  if (magnitude?.mode === 'FIXED' && Number.isInteger(magnitude.amount) && magnitude.amount >= 1) {
    return { fixed: magnitude.amount, dice: [] }
  }
  if (
    magnitude?.mode === 'DICE' &&
    Number.isInteger(magnitude.count) &&
    Number.isInteger(magnitude.sides) &&
    magnitude.count >= 1 &&
    magnitude.sides >= 2
  ) {
    return { fixed: 0, dice: [{ count: magnitude.count, sides: magnitude.sides }] }
  }
  return null
}

const basisPointsOf = (magnitude: CombatMagnitude | undefined): number | null =>
  magnitude?.mode === 'PERCENTAGE' &&
  Number.isInteger(magnitude.basisPoints) &&
  magnitude.basisPoints >= 1 &&
  magnitude.basisPoints <= MAX_BASIS_POINTS
    ? magnitude.basisPoints
    : null

const isMissionStatistic = (value: string | undefined): value is MissionStatistic =>
  value === 'ATTACK' || value === 'DAMAGE' || value === 'DEFENSE'

/** El heroe es el unico destinatario de una curacion o una mejora propia. */
const isHero = (target: string): boolean =>
  target === 'SELF' || target === 'ALLY' || target === 'ALLIED_GROUP'

/** Un efecto con su semantica de mision, o el motivo por el que no la tiene. */
const effectOf = (effect: CombatAbilityEffect): MissionEffect | string => {
  const turns = effect.durationTurns ?? 1

  switch (effect.kind) {
    case 'STAT_MODIFIER': {
      const amount = bonusOf(effect.magnitude)
      if (amount === null)
        return 'la magnitud del efecto no es un entero >= 1 ni unos dados validos.'
      const statistic = effect.statistic
      if (effect.operation === 'INCREASE' && isHero(effect.target)) {
        if (statistic === 'HEALING' || statistic === 'HEALTH')
          return { kind: 'HEAL', amount, turns }
        if (isMissionStatistic(statistic) && effect.target === 'SELF') {
          return { kind: 'MODIFIER', target: 'SELF', statistic, amount, turns }
        }
      }
      if (effect.operation === 'DECREASE' && effect.target === 'OPPONENT') {
        if (isMissionStatistic(statistic)) {
          return { kind: 'MODIFIER', target: 'OPPONENT', statistic, amount, turns }
        }
        if (statistic === 'POWER') return 'los enemigos de una mision no usan Poder.'
      }
      return `un modificador ${String(effect.operation)} de ${String(statistic)} sobre ${effect.target} no esta definido en misiones.`
    }
    case 'DAMAGE': {
      if (effect.target !== 'OPPONENT')
        return `el dano sobre ${effect.target} no esta definido en misiones.`
      if (effect.durationTurns !== undefined)
        return 'el dano con duracion no esta definido en misiones.'
      const amount = bonusOf(effect.magnitude)
      return amount === null
        ? 'la magnitud del dano no es un entero >= 1 ni unos dados validos.'
        : { kind: 'DIRECT_DAMAGE', amount }
    }
    case 'HEALING': {
      if (!isHero(effect.target))
        return `la curacion sobre ${effect.target} no esta definida en misiones.`
      const amount = bonusOf(effect.magnitude)
      return amount === null
        ? 'la magnitud de la curacion no es un entero >= 1 ni unos dados validos.'
        : { kind: 'HEAL', amount, turns }
    }
    case 'REVIVE': {
      if (!isHero(effect.target))
        return `la reanimacion sobre ${effect.target} no esta definida en misiones.`
      const basisPoints = basisPointsOf(effect.magnitude)
      return basisPoints === null
        ? 'la reanimacion necesita un porcentaje entre 0,01 % y 100 %.'
        : { kind: 'HEAL_PERCENT', basisPoints }
    }
    case 'IMMUNITY':
      return effect.target === 'SELF'
        ? { kind: 'IMMUNITY', turns }
        : `la inmunidad sobre ${effect.target} no esta definida en misiones.`
    case 'REFLECT_DAMAGE': {
      const basisPoints = basisPointsOf(effect.magnitude)
      if (effect.target !== 'OPPONENT' || basisPoints === null) {
        return 'el reflejo necesita un porcentaje y devolver el dano al oponente.'
      }
      return { kind: 'REFLECT', basisPoints, turns }
    }
    default:
      return `el efecto ${effect.kind} no tiene semantica en misiones.`
  }
}

/**
 * Que hace la habilidad en una mision. Las mejoras propias de Ataque o Dano sin
 * duracion se acumulan igual que en `evaluateSkill` (mismo orden de dados), para
 * que las habilidades que ya se ejecutaban den exactamente el mismo resultado.
 */
export const evaluateMissionAbility = (ability: CombatAbility): MissionAbilitySupport => {
  if (ability.effects.length === 0) return unsupported('la habilidad no declara ningun efecto.')

  const attack = { fixed: 0, dice: [] as SkillDice[] }
  const damage = { fixed: 0, dice: [] as SkillDice[] }
  const effects: MissionEffect[] = []
  let attacks = false

  for (const effect of ability.effects) {
    if (effect.hasActivationCondition) {
      return unsupported('un efecto condicionado no se evalua: Combat no recibe la condicion.')
    }
    const mission = effectOf(effect)
    if (typeof mission === 'string') return unsupported(mission)

    const instantBonus =
      mission.kind === 'MODIFIER' &&
      mission.target === 'SELF' &&
      mission.statistic !== 'DEFENSE' &&
      effect.durationTurns === undefined

    if (
      mission.kind === 'MODIFIER' &&
      mission.target === 'SELF' &&
      mission.statistic !== 'DEFENSE'
    ) {
      attacks = true
    }
    if (instantBonus) {
      const bonus = mission.statistic === 'ATTACK' ? attack : damage
      bonus.fixed += mission.amount.fixed
      bonus.dice.push(...mission.amount.dice)
    } else {
      effects.push(mission)
    }
  }

  return { supported: true, attacks, attackBonus: attack, damageBonus: damage, effects }
}
