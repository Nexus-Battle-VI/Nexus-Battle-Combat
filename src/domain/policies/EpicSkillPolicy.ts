import type { CombatAbilityEffect, CombatMagnitude } from '../entities/CombatProfile'
import { MAX_HEALING_BASIS_POINTS } from './HealApplicationPolicy'
import {
  bonusOf,
  isUsableMagnitude,
  type SkillBonus,
  type TemporalEffectAudience,
} from './SkillEffectPolicy'

/**
 * Que efectos de la epica equipada sabe ejecutar Combat (correccion HU-19/HU-31,
 * tras GAP-HU31-CATALOG-MULTI-EFFECT). DISTINTO de `SkillEffectPolicy.evaluateSkill`:
 * una epica puede combinar VARIOS efectos heterogeneos a la vez -- p.ej. un bono de
 * Dano Y un bono de Critico simultaneos (Golpe de defensa, Tabla 20) -- mientras que
 * una habilidad se resuelve como UNA sola familia, nunca mezclada. No se reimplementa
 * la validacion de magnitud/forma: `isUsableMagnitude`/`bonusOf` se reutilizan tal
 * cual de `SkillEffectPolicy`.
 *
 * DECISION TECNICA (ninguna fuente formal fija esto): usar la epica NO es un ataque
 * -- no existe "esta resolucion" a la que sumar un bono instantaneo como SI existe al
 * usar una habilidad ofensiva (patron INSTANT_STAT). Por eso TODO `STAT_MODIFIER`
 * sobre ATTACK/DAMAGE/DEFENSE/CRITICAL_CHANCE/POWER de una epica se trata SIEMPRE
 * como efecto TEMPORAL, con duracion = `durationTurns` si la epica la declara, o la
 * `cooldownTurns` de la propia epica en caso contrario -- el bono dura exactamente lo
 * que la epica esta en recarga, ni mas (no se podria reutilizar antes) ni menos
 * (no dejaria un hueco sin bono ni recarga).
 *
 * PENDIENTE DOCUMENTADO (no oculto, `P-HU31-STAT-CONSULTATION-GAP`): `CRITICAL_CHANCE`
 * y `POWER` se REGISTRAN como efecto activo (igual que ya ocurre con `IMMUNITY` para
 * habilidades: bookkeeping real, decrementado cada cierre de turno propio) pero HOY
 * ningun punto de resolucion de Combat los CONSULTA (`Combatant.statBonus` solo lee
 * ATTACK/DAMAGE/DEFENSE) -- brecha PRE-EXISTENTE del motor (misma categoria que
 * `IMMUNITY`, confirmada por auditoria), no introducida por esta correccion, fuera de
 * alcance de HU-31 (pertenece a una ampliacion futura de HU-25/el motor de Poder).
 *
 * NO soportado todavia (rechazo EXPLICITO de la epica completa, nunca silencioso):
 * `REFLECT_DAMAGE`, `TEMPORARY_STATUS`, `ENEMY_GROUP`, y una epica cuyos efectos
 * exijan audiencias incompatibles entre si (p.ej. uno sobre ALLY y otro sobre
 * OPPONENT) -- ningun escenario de la Tabla 20 real lo necesita. "No se aplica a
 * medias": si UN efecto no esta soportado, NINGUNO de la misma epica se ejecuta.
 */

export type EpicStatStatistic =
  'ATTACK' | 'DAMAGE' | 'DEFENSE' | 'HEALING' | 'CRITICAL_CHANCE' | 'POWER'

export interface EpicTemporalEffect {
  readonly statistic: EpicStatStatistic
  readonly operation: 'INCREASE' | 'DECREASE'
  readonly audience: TemporalEffectAudience
  readonly bonus: SkillBonus
  readonly durationTurns: number
}

export interface EpicImmunityEffect {
  readonly immunityCode: string
  readonly durationTurns: number
}

export interface EpicInstantHeal {
  readonly audience: 'ALLY' | 'ALLIED_GROUP'
  readonly bonus: SkillBonus
}

export interface EpicDirectDamage {
  readonly bonus: SkillBonus
}

export interface EpicRevive {
  readonly magnitude: CombatMagnitude & { readonly mode: 'PERCENTAGE' }
}

export interface EpicEffectPlan {
  readonly temporalStats: readonly EpicTemporalEffect[]
  readonly immunities: readonly EpicImmunityEffect[]
  readonly instantHeals: readonly EpicInstantHeal[]
  readonly directDamage: readonly EpicDirectDamage[]
  readonly revives: readonly EpicRevive[]
  /** La UNICA audiencia distinta de SELF que algun efecto necesita, o `null` si ninguno. */
  readonly requiredAudience: 'ALLY' | 'ALLIED_GROUP' | 'OPPONENT' | null
}

export type EpicEffectSupport =
  | { readonly supported: true; readonly plan: EpicEffectPlan }
  | { readonly supported: false; readonly reason: string }

const unsupported = (reason: string): EpicEffectSupport => ({ supported: false, reason })

const STAT_STATISTICS: readonly EpicStatStatistic[] = [
  'ATTACK',
  'DAMAGE',
  'DEFENSE',
  'HEALING',
  'CRITICAL_CHANCE',
  'POWER',
]

const isEpicStatStatistic = (value: unknown): value is EpicStatStatistic =>
  typeof value === 'string' && (STAT_STATISTICS as readonly string[]).includes(value)

type Classified =
  | { readonly kind: 'TEMPORAL_STAT'; readonly effect: EpicTemporalEffect }
  | { readonly kind: 'INSTANT_HEAL'; readonly effect: EpicInstantHeal }
  | { readonly kind: 'IMMUNITY'; readonly effect: EpicImmunityEffect }
  | { readonly kind: 'DIRECT_DAMAGE'; readonly effect: EpicDirectDamage }
  | { readonly kind: 'REVIVE'; readonly effect: EpicRevive }
  | { readonly reason: string }

const classifyStatModifier = (effect: CombatAbilityEffect, cooldownTurns: number): Classified => {
  if (effect.hasActivationCondition) {
    return {
      reason: 'un efecto condicionado no se evalua: la condicion no esta definida formalmente.',
    }
  }

  if (!isEpicStatStatistic(effect.statistic)) {
    return { reason: `la estadistica ${String(effect.statistic)} no se soporta en una epica.` }
  }

  if (effect.operation !== 'INCREASE' && effect.operation !== 'DECREASE') {
    return { reason: `la operacion ${String(effect.operation)} no esta definida.` }
  }

  if (!isUsableMagnitude(effect) || effect.magnitude === undefined) {
    return { reason: 'la magnitud del efecto no es un entero >= 1 ni unos dados validos.' }
  }

  const bonus = bonusOf(effect.magnitude)
  const durationTurns = effect.durationTurns ?? cooldownTurns

  if (effect.statistic === 'HEALING') {
    if (effect.operation !== 'INCREASE') {
      return { reason: 'la Sanacion solo se soporta en INCREASE.' }
    }

    if (effect.target !== 'ALLY' && effect.target !== 'ALLIED_GROUP') {
      return {
        reason: 'una sanacion sobre ese objetivo no esta definida: solo aliado o grupo aliado.',
      }
    }

    if (effect.durationTurns === undefined) {
      return { kind: 'INSTANT_HEAL', effect: { audience: effect.target, bonus } }
    }

    return {
      kind: 'TEMPORAL_STAT',
      effect: {
        statistic: 'HEALING',
        operation: 'INCREASE',
        audience: effect.target,
        bonus,
        durationTurns,
      },
    }
  }

  if (effect.target !== 'SELF' && effect.target !== 'OPPONENT') {
    return {
      reason: `un modificador de ${effect.statistic} en una epica solo esta definido sobre uno mismo o el oponente.`,
    }
  }

  return {
    kind: 'TEMPORAL_STAT',
    effect: {
      statistic: effect.statistic,
      operation: effect.operation,
      audience: effect.target,
      bonus,
      durationTurns,
    },
  }
}

const classifyDirectDamage = (effect: CombatAbilityEffect): Classified => {
  if (effect.target !== 'OPPONENT') {
    return { reason: 'un dano directo solo esta definido sobre el oponente.' }
  }

  if (effect.hasActivationCondition) {
    return {
      reason: 'un efecto condicionado no se evalua: la condicion no esta definida formalmente.',
    }
  }

  if (effect.durationTurns !== undefined) {
    return { reason: 'un dano directo no tiene una duracion definida.' }
  }

  if (!isUsableMagnitude(effect) || effect.magnitude === undefined) {
    return { reason: 'la magnitud del efecto no es un entero >= 1 ni unos dados validos.' }
  }

  return { kind: 'DIRECT_DAMAGE', effect: { bonus: bonusOf(effect.magnitude) } }
}

const classifyRevive = (effect: CombatAbilityEffect): Classified => {
  if (effect.target !== 'ALLY') {
    return { reason: 'una reanimacion solo esta definida sobre un aliado.' }
  }

  if (effect.durationTurns !== undefined) {
    return { reason: 'una reanimacion no tiene una duracion definida.' }
  }

  if (effect.hasActivationCondition) {
    return {
      reason: 'un efecto condicionado no se evalua: la condicion no esta definida formalmente.',
    }
  }

  const magnitude = effect.magnitude

  if (
    magnitude?.mode !== 'PERCENTAGE' ||
    !Number.isInteger(magnitude.basisPoints) ||
    magnitude.basisPoints < 1 ||
    magnitude.basisPoints > MAX_HEALING_BASIS_POINTS
  ) {
    return {
      reason: `la magnitud de una reanimacion debe ser PERCENTAGE entre 1 y ${String(MAX_HEALING_BASIS_POINTS)} puntos base.`,
    }
  }

  return { kind: 'REVIVE', effect: { magnitude } }
}

const classifyImmunity = (effect: CombatAbilityEffect, cooldownTurns: number): Classified => {
  if (effect.target !== 'SELF') {
    return { reason: 'una inmunidad solo esta definida sobre uno mismo.' }
  }

  if (effect.hasActivationCondition) {
    return {
      reason: 'un efecto condicionado no se evalua: la condicion no esta definida formalmente.',
    }
  }

  if (effect.magnitude !== undefined) {
    return { reason: 'una inmunidad no lleva magnitud.' }
  }

  if (typeof effect.immunityCode !== 'string' || effect.immunityCode.trim().length === 0) {
    return { reason: 'una inmunidad necesita su codigo (immunityCode) formalmente declarado.' }
  }

  return {
    kind: 'IMMUNITY',
    effect: {
      immunityCode: effect.immunityCode,
      durationTurns: effect.durationTurns ?? cooldownTurns,
    },
  }
}

const classifyEpicEffect = (effect: CombatAbilityEffect, cooldownTurns: number): Classified => {
  switch (effect.kind) {
    case 'STAT_MODIFIER':
      return classifyStatModifier(effect, cooldownTurns)
    case 'DAMAGE':
      return classifyDirectDamage(effect)
    case 'REVIVE':
      return classifyRevive(effect)
    case 'IMMUNITY':
      return classifyImmunity(effect, cooldownTurns)
    default:
      return {
        reason: `el efecto ${effect.kind} no tiene una semantica de epica formalmente definida.`,
      }
  }
}

const audienceOf = (classified: Classified): 'ALLY' | 'ALLIED_GROUP' | 'OPPONENT' | null => {
  if ('reason' in classified) {
    return null
  }

  if (classified.kind === 'INSTANT_HEAL') {
    return classified.effect.audience
  }

  if (classified.kind === 'DIRECT_DAMAGE') {
    return 'OPPONENT'
  }

  if (classified.kind === 'REVIVE') {
    return 'ALLY'
  }

  if (classified.kind === 'TEMPORAL_STAT' && classified.effect.audience !== 'SELF') {
    return classified.effect.audience === 'OPPONENT' ? 'OPPONENT' : classified.effect.audience
  }

  return null
}

/**
 * Clasifica TODOS los efectos de la epica (lo que `applied.baseApplied` +
 * `applied.additionalApplied` ya resolvio en Player-Inventory, sin reinterpretar la
 * aplicabilidad general/especifica aqui: eso ya quedo decidido). "No se aplica a
 * medias": si algun efecto no encaja en ningun patron, o las audiencias resultan
 * incompatibles entre si, se rechaza LA EPICA ENTERA.
 */
export const evaluateEpicEffects = (
  effects: readonly CombatAbilityEffect[],
  cooldownTurns: number,
): EpicEffectSupport => {
  if (effects.length === 0) {
    return unsupported('la epica no declara ningun efecto aplicable.')
  }

  const classified: Classified[] = []

  for (const effect of effects) {
    const result = classifyEpicEffect(effect, cooldownTurns)

    if ('reason' in result) {
      return unsupported(result.reason)
    }

    classified.push(result)
  }

  const audiences = new Set(classified.map(audienceOf).filter((audience) => audience !== null))

  if (audiences.size > 1) {
    return unsupported('la epica combina efectos con audiencias incompatibles entre si.')
  }

  const [firstAudience] = audiences
  const requiredAudience =
    audiences.size === 1 && firstAudience !== undefined ? firstAudience : null

  return {
    supported: true,
    plan: {
      temporalStats: classified
        .filter(
          (c): c is Extract<Classified, { kind: 'TEMPORAL_STAT' }> =>
            'kind' in c && c.kind === 'TEMPORAL_STAT',
        )
        .map((c) => c.effect),
      immunities: classified
        .filter(
          (c): c is Extract<Classified, { kind: 'IMMUNITY' }> =>
            'kind' in c && c.kind === 'IMMUNITY',
        )
        .map((c) => c.effect),
      instantHeals: classified
        .filter(
          (c): c is Extract<Classified, { kind: 'INSTANT_HEAL' }> =>
            'kind' in c && c.kind === 'INSTANT_HEAL',
        )
        .map((c) => c.effect),
      directDamage: classified
        .filter(
          (c): c is Extract<Classified, { kind: 'DIRECT_DAMAGE' }> =>
            'kind' in c && c.kind === 'DIRECT_DAMAGE',
        )
        .map((c) => c.effect),
      revives: classified
        .filter(
          (c): c is Extract<Classified, { kind: 'REVIVE' }> => 'kind' in c && c.kind === 'REVIVE',
        )
        .map((c) => c.effect),
      requiredAudience,
    },
  }
}
