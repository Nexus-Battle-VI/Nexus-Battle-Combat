import type { CombatAbility, CombatAbilityEffect, CombatMagnitude } from '../entities/CombatProfile'
import { MAX_HEALING_BASIS_POINTS } from './HealApplicationPolicy'

/**
 * Que efectos de una habilidad especial sabe ejecutar Combat (HU-19, contrato
 * `hu-19-skills-v1`, §10.2; excepcion de curacion HU-12/Tabla 7, sin Task de
 * Management -- autorizada verbalmente por el PO).
 *
 * Catalog v1 puede describir efectos que el documento oficial NO define con precision
 * (duracion, condicion, reanimacion parcial, inmunidad, reflejo, efectos de grupo).
 * Se ejecuta UNICAMENTE lo formalmente soportado; lo demas se rechaza de forma
 * explicita: no se aplica a medias ni se descarta en silencio.
 *
 * Dos patrones soportados, cada uno exclusivo (una habilidad es de UN patron, sus
 * efectos no se mezclan):
 *
 *  1. DAMAGE: TODOS los efectos son un modificador propio de Ataque o de Dano
 *     (`STAT_MODIFIER`, `SELF`, `INCREASE`, `ATTACK`/`DAMAGE`, magnitud `FIXED` o
 *     `DICE`, sin duracion y sin condicion). El patron «+N (o +NdM) al ataque / al
 *     dano» de la Tabla 7, que la decision confirmada por el PO lee como una mejora
 *     de ESA accion (el turno es la accion).
 *  2. HEAL: UN unico efecto `REVIVE` (el `kind` real del Catalog desplegado para
 *     esta habilidad, comprobado contra su API el 2026-09-21: NO es `HEALING`),
 *     `target: 'ALLY'`, magnitud `PERCENTAGE`, sin duracion y sin condicion -- la
 *     unica accion de sanador formalmente soportada hoy es Reanimacion (Medico,
 *     Tabla 7: "Sana el 100% de la vida del companero", magnitud 10000 puntos
 *     base). El nombre de la habilidad y su `kind` (`REVIVE`, no `HEALING`)
 *     sugieren que su uso real es levantar a un companero CAIDO (Vida 0, todavia
 *     dirigible dentro de su equipo mientras este no este eliminado); el
 *     objetivo NO se exige vivo ni caido: el texto de la Tabla 7 solo dice "sana
 *     el 100%", asi que se acepta cualquier companero (vivo o caido) y se le deja
 *     la Vida en su maximo -- ni una lectura mas estrecha ni una mas amplia que
 *     la que el documento sostiene. Las otras 5 acciones de sanador (autobuff de
 *     "Sanar" con `statistic: HEALING`, y curacion de grupo/con duracion como
 *     Canto del Bosque) NO estan soportadas: quedan fuera a proposito, mismo
 *     criterio de "no aplicar a medias" -- se documentan como pendiente, no se
 *     inventan. Un autobuff a `HEALING` tampoco tendria a que aplicarse hoy: no
 *     existe una accion "curacion basica" analoga al ataque basico que consuma
 *     ese bono, a diferencia de Ataque/Dano con el ataque basico.
 *
 * Pura y sin E/S: no sortea (HEAL nunca consume la secuencia HU-24; DAMAGE la
 * consume en el caso de uso, no aqui). Devuelve lo que el caso de uso necesita
 * para resolver cada patron.
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
      readonly kind: 'DAMAGE'
      readonly attackBonus: SkillBonus
      readonly damageBonus: SkillBonus
    }
  | {
      readonly supported: true
      readonly kind: 'HEAL'
      /** Magnitud `PERCENTAGE` del efecto `REVIVE`, ya validada (1..10000). */
      readonly healMagnitude: CombatMagnitude & { readonly mode: 'PERCENTAGE' }
    }
  | { readonly supported: false; readonly reason: string }

const unsupported = (reason: string): SkillSupport => ({ supported: false, reason })

/** El motivo por el que un efecto DAMAGE no esta soportado, o `null` si lo esta. */
const unsupportedDamageReason = (effect: CombatAbilityEffect): string | null => {
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

/**
 * Evalua una habilidad de UN unico efecto `REVIVE`. Cualquier otra forma (mas de
 * un efecto, objetivo distinto de `ALLY`, duracion, condicion, magnitud fuera de
 * `PERCENTAGE` 1..10000) se rechaza explicitamente: no hay una segunda habilidad
 * de curacion soportada hoy para caer a un comportamiento parcial.
 */
const evaluateHealSkill = (effects: readonly CombatAbilityEffect[]): SkillSupport => {
  if (effects.length !== 1) {
    return unsupported(
      'una habilidad de curacion solo soporta un unico efecto (Reanimacion, Tabla 7).',
    )
  }

  const effect = effects[0]

  if (effect?.kind !== 'REVIVE') {
    return unsupported(
      `el efecto ${String(effect?.kind)} no tiene una semantica formalmente definida.`,
    )
  }

  if (effect.target !== 'ALLY') {
    return unsupported(
      `una curacion sobre ${effect.target} no esta definida: solo se soporta un aliado.`,
    )
  }

  if (effect.durationTurns !== undefined) {
    return unsupported('una curacion con duracion (grupo/varios turnos) no esta soportada todavia.')
  }

  if (effect.hasActivationCondition) {
    return unsupported(
      'un efecto condicionado no se evalua: la condicion no esta definida formalmente.',
    )
  }

  const magnitude = effect.magnitude

  if (
    magnitude?.mode !== 'PERCENTAGE' ||
    !Number.isInteger(magnitude.basisPoints) ||
    magnitude.basisPoints < 1 ||
    magnitude.basisPoints > MAX_HEALING_BASIS_POINTS
  ) {
    return unsupported(
      `la magnitud de curacion debe ser PERCENTAGE entre 1 y ${String(MAX_HEALING_BASIS_POINTS)} puntos base.`,
    )
  }

  return { supported: true, kind: 'HEAL', healMagnitude: magnitude }
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

  if (ability.effects.some((effect) => effect.kind === 'REVIVE')) {
    return evaluateHealSkill(ability.effects)
  }

  const attack = { fixed: 0, dice: [] as SkillDice[] }
  const damage = { fixed: 0, dice: [] as SkillDice[] }

  for (const effect of ability.effects) {
    const reason = unsupportedDamageReason(effect)

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

  return { supported: true, kind: 'DAMAGE', attackBonus: attack, damageBonus: damage }
}
