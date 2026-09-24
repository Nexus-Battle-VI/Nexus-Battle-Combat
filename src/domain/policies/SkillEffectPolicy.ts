import type { CombatAbility, CombatAbilityEffect, CombatMagnitude } from '../entities/CombatProfile'
import { MAX_HEALING_BASIS_POINTS } from './HealApplicationPolicy'

/**
 * Que efectos de una habilidad especial sabe ejecutar Combat (HU-19, contrato `hu-19-skills-v2`,
 * sucesor de `hu-19-skills-v1` §10.2). Catalog v1 puede describir efectos que el documento
 * oficial NO define con precision; se ejecuta UNICAMENTE lo formalmente soportado, lo demas se
 * rechaza de forma explicita: no se aplica a medias ni se descarta en silencio.
 *
 * DECLARATIVO POR PATRON, no por habilidad: nunca hay un `if (ability.name === 'X')`. Cada
 * efecto se clasifica UNICAMENTE por su forma (`kind`/`target`/`statistic`/`operation`/
 * `magnitude`/`durationTurns`/`hasActivationCondition`/`immunityCode`); una habilidad esta
 * soportada solo si TODOS sus efectos, individualmente, encajan en alguno de los patrones de
 * abajo (§3 del contrato v2, "no se aplica a medias" -- principio heredado de v1 sin cambios).
 *
 * Patrones soportados (v2 amplia v1, sin tocar lo que v1 ya resolvia):
 *
 *  1. INSTANT_STAT (v1, SIN CAMBIOS): `STAT_MODIFIER`, `SELF`, `INCREASE`, `ATTACK`/`DAMAGE`,
 *     magnitud `FIXED`/`DICE`, sin duracion, sin condicion. El patron «+N (o +NdM) al ataque /
 *     al dano» de la Tabla 7: un bono que solo vale para ESA resolucion (v1 §4).
 *  2. TEMPORAL_STAT (v2, NUEVO): `STAT_MODIFIER` con `statistic ∈ {ATTACK, DAMAGE, DEFENSE}` que
 *     NO es el patron 1 (por duracion, por objetivo distinto de `SELF`, o por ser `DEFENSE`), o
 *     `statistic = HEALING` con duracion. Crea un efecto temporal de batalla (§2 del contrato):
 *     no toca ESTA resolucion, se consulta en cada resolucion FUTURA del combatiente objetivo
 *     hasta que expira. Cubre Mano de piedra, Cono de hielo, Bola de hielo, Piquete, Cortada,
 *     Vinculo Natural.
 *  3. INSTANT_HEAL (v2, NUEVO): `STAT_MODIFIER`, `statistic = HEALING`, `operation = INCREASE`,
 *     `target ∈ {ALLY, ALLIED_GROUP}`, sin duracion. Sana de inmediato (determinista salvo el
 *     dado propio de la magnitud). Cubre Toque de la Vida, Curacion Directa, Neutralizacion de
 *     Efectos.
 *  4. DIRECT_DAMAGE (v2, NUEVO): `kind = DAMAGE`, `target = OPPONENT`, sin resolucion de
 *     Ataque/Defensa (contrato §3). Cubre Agonia.
 *  5. REFLECT_DAMAGE (v2, NUEVO): `kind = REFLECT_DAMAGE`, `target = OPPONENT`, magnitud
 *     `PERCENTAGE`, `hasActivationCondition = true` (la condicion ES el patron: "recibio dano en
 *     su turno propio anterior", contrato §6). Cubre Pare de fuego.
 *  6. IMMUNITY (v2, NUEVO, estructural): `kind = IMMUNITY`, `target = SELF`, `immunityCode`
 *     presente, SIN `magnitude` (contrato §5). Ninguna de las 24 habilidades queda soportada
 *     SOLO con esto: Defensa feroz sigue rechazada porque su segundo componente ("3d6 al dano
 *     magico") no tiene `kind` ni campo formal.
 *  7. HEAL (v1, SIN CAMBIOS): UN unico efecto `REVIVE`, `target: ALLY`, magnitud `PERCENTAGE`,
 *     sin duracion ni condicion -- Reanimacion (excepcion de curacion de HU-12).
 *
 * Una habilidad se resuelve como UNA de tres familias, segun la combinacion de patrones de sus
 * efectos (nunca mezcladas -- si los patrones no encajan en la MISMA familia, se rechaza):
 *   - `HEAL`: el unico efecto es REVIVE (v1, sin cambios).
 *   - `HEALING`: TODOS sus efectos son INSTANT_HEAL o TEMPORAL_STAT-de-sanacion.
 *   - `DIRECT_DAMAGE`: TODOS sus efectos son DIRECT_DAMAGE.
 *   - `DAMAGE`: TODOS sus efectos son INSTANT_STAT, TEMPORAL_STAT-no-sanacion, REFLECT_DAMAGE o
 *     IMMUNITY (la familia "ofensiva": se resuelve como un ataque mejorado, v1 §4).
 *
 * Pura y sin E/S: no sortea (ningun `kind` consume la secuencia HU-24 aqui; los dados de una
 * magnitud DICE se resuelven en el caso de uso, que SI tiene `RandomSequencePort`). Devuelve lo
 * que el caso de uso y el agregado necesitan para resolver cada patron.
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

/** A quien afecta un efecto temporal (contrato v2 §2): siempre relativo al ACTOR que usa la habilidad. */
export type TemporalEffectAudience = 'SELF' | 'OPPONENT' | 'ALLY' | 'ALLIED_GROUP'

/**
 * Una plantilla de efecto temporal (contrato v2 §2), SIN resolver todavia: la magnitud puede
 * traer dados pendientes (se resuelven una sola vez, con `RandomSequencePort`, cuando el caso de
 * uso aplica la habilidad) y la duracion puede ser `null` (sin `durationTurns` declarado: aplica
 * durante exactamente UN turno propio del objetivo -- el minimo estructural para que un efecto
 * sin duracion explicita en Catalog siga siendo un efecto real, sin inventar una magnitud).
 */
export type TemporalEffectTemplate =
  | {
      readonly family: 'STAT'
      readonly statistic: 'ATTACK' | 'DAMAGE' | 'DEFENSE' | 'HEALING'
      readonly operation: 'INCREASE' | 'DECREASE'
      readonly audience: TemporalEffectAudience
      readonly bonus: SkillBonus
      readonly durationTurns: number | null
    }
  | {
      readonly family: 'IMMUNITY'
      readonly immunityCode: string
      readonly durationTurns: number | null
    }

export type SkillSupport =
  | {
      readonly supported: true
      readonly kind: 'DAMAGE'
      /** Bono de ESTA resolucion (patron 1, v1 sin cambios). */
      readonly attackBonus: SkillBonus
      readonly damageBonus: SkillBonus
      /** Patron 5 (REFLECT_DAMAGE), o `null` si la habilidad no lo declara. */
      readonly reflect: { readonly basisPoints: number } | null
      /** Patrones 2 y 6 (TEMPORAL_STAT no-sanacion, IMMUNITY), sin resolver. */
      readonly temporalEffects: readonly TemporalEffectTemplate[]
    }
  | {
      readonly supported: true
      readonly kind: 'DIRECT_DAMAGE'
      readonly damageBonus: SkillBonus
    }
  | {
      readonly supported: true
      readonly kind: 'HEAL'
      /** Magnitud `PERCENTAGE` del efecto `REVIVE`, ya validada (1..10000). */
      readonly healMagnitude: CombatMagnitude & { readonly mode: 'PERCENTAGE' }
    }
  | {
      readonly supported: true
      readonly kind: 'HEALING'
      /** `ALLIED_GROUP` si ALGUN efecto lo declara (Canto del Bosque); si no, `ALLY`. */
      readonly audience: 'ALLY' | 'ALLIED_GROUP'
      /** Bono de sanacion INSTANTANEA (patron 3), aplicado ya en esta accion. */
      readonly healBonus: SkillBonus
      /** Patron 2 (TEMPORAL_STAT de sanacion: Vinculo Natural, Canto del Bosque), sin resolver. */
      readonly temporalEffects: readonly TemporalEffectTemplate[]
    }
  | { readonly supported: false; readonly reason: string }

const unsupported = (reason: string): SkillSupport => ({ supported: false, reason })

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

/** `magnitude` ya comprobada usable (`isUsableMagnitude`) a un `SkillBonus` de un solo efecto. */
const bonusOf = (magnitude: CombatMagnitude): SkillBonus =>
  magnitude.mode === 'FIXED'
    ? { fixed: magnitude.amount, dice: [] }
    : magnitude.mode === 'DICE'
      ? { fixed: 0, dice: [{ count: magnitude.count, sides: magnitude.sides }] }
      : { fixed: 0, dice: [] } // inalcanzable: PERCENTAGE nunca pasa `isUsableMagnitude`

const addBonus = (total: SkillBonus, addition: SkillBonus): SkillBonus => ({
  fixed: total.fixed + addition.fixed,
  dice: [...total.dice, ...addition.dice],
})

const EMPTY_BONUS: SkillBonus = { fixed: 0, dice: [] }
const aggregate = (bonuses: readonly SkillBonus[]): SkillBonus =>
  bonuses.reduce(addBonus, EMPTY_BONUS)

const TEMPORAL_AUDIENCES: readonly TemporalEffectAudience[] = [
  'SELF',
  'OPPONENT',
  'ALLY',
  'ALLIED_GROUP',
]
const isTemporalAudience = (value: string): value is TemporalEffectAudience =>
  (TEMPORAL_AUDIENCES as readonly string[]).includes(value)

/** Clasificacion de UN efecto: a que patron pertenece, o por que ninguno lo acepta. */
type EffectClass =
  | {
      readonly family: 'INSTANT_STAT'
      readonly statistic: 'ATTACK' | 'DAMAGE'
      readonly bonus: SkillBonus
    }
  | {
      readonly family: 'TEMPORAL_STAT'
      readonly statistic: 'ATTACK' | 'DAMAGE' | 'DEFENSE'
      readonly operation: 'INCREASE' | 'DECREASE'
      readonly audience: TemporalEffectAudience
      readonly bonus: SkillBonus
      readonly durationTurns: number | null
    }
  | {
      readonly family: 'INSTANT_HEAL'
      readonly audience: 'ALLY' | 'ALLIED_GROUP'
      readonly bonus: SkillBonus
    }
  | {
      readonly family: 'TEMPORAL_HEAL'
      readonly audience: 'ALLY' | 'ALLIED_GROUP'
      readonly bonus: SkillBonus
      readonly durationTurns: number | null
    }
  | { readonly family: 'DIRECT_DAMAGE'; readonly bonus: SkillBonus }
  | { readonly family: 'REFLECT'; readonly basisPoints: number }
  | {
      readonly family: 'IMMUNITY'
      readonly immunityCode: string
      readonly durationTurns: number | null
    }

const classifyStatModifier = (
  effect: CombatAbilityEffect,
): EffectClass | { readonly reason: string } => {
  if (!isTemporalAudience(effect.target)) {
    return { reason: `un efecto sobre ${effect.target} no esta definido.` }
  }

  if (effect.operation !== 'INCREASE' && effect.operation !== 'DECREASE') {
    return { reason: `la operacion ${String(effect.operation)} no esta definida.` }
  }

  if (effect.hasActivationCondition) {
    return {
      reason: 'un efecto condicionado no se evalua: la condicion no esta definida formalmente.',
    }
  }

  if (!isUsableMagnitude(effect) || effect.magnitude === undefined) {
    return { reason: 'la magnitud del efecto no es un entero >= 1 ni unos dados validos.' }
  }

  const bonus = bonusOf(effect.magnitude)
  const durationTurns = effect.durationTurns ?? null

  if (effect.statistic === 'ATTACK' || effect.statistic === 'DAMAGE') {
    if (effect.target === 'SELF' && effect.operation === 'INCREASE' && durationTurns === null) {
      return { family: 'INSTANT_STAT', statistic: effect.statistic, bonus }
    }

    if (effect.target !== 'SELF' && effect.target !== 'OPPONENT') {
      return {
        reason: `un modificador de ${effect.statistic} solo esta definido sobre uno mismo o el oponente.`,
      }
    }

    return {
      family: 'TEMPORAL_STAT',
      statistic: effect.statistic,
      operation: effect.operation,
      audience: effect.target,
      bonus,
      durationTurns,
    }
  }

  if (effect.statistic === 'DEFENSE') {
    if (effect.target !== 'SELF' && effect.target !== 'OPPONENT') {
      return {
        reason: 'un modificador de DEFENSE solo esta definido sobre uno mismo o el oponente.',
      }
    }

    return {
      family: 'TEMPORAL_STAT',
      statistic: 'DEFENSE',
      operation: effect.operation,
      audience: effect.target,
      bonus,
      durationTurns,
    }
  }

  if (effect.statistic === 'HEALING') {
    if (effect.operation !== 'INCREASE') {
      return { reason: 'la Sanacion solo se soporta en INCREASE.' }
    }

    if (effect.target !== 'ALLY' && effect.target !== 'ALLIED_GROUP') {
      return {
        reason: 'una sanacion sobre ese objetivo no esta definida: solo aliado o grupo aliado.',
      }
    }

    return durationTurns === null
      ? { family: 'INSTANT_HEAL', audience: effect.target, bonus }
      : { family: 'TEMPORAL_HEAL', audience: effect.target, bonus, durationTurns }
  }

  return { reason: `la estadistica ${String(effect.statistic)} no se soporta.` }
}

const classifyDirectDamage = (
  effect: CombatAbilityEffect,
): EffectClass | { readonly reason: string } => {
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

  return { family: 'DIRECT_DAMAGE', bonus: bonusOf(effect.magnitude) }
}

const classifyReflectDamage = (
  effect: CombatAbilityEffect,
): EffectClass | { readonly reason: string } => {
  if (effect.target !== 'OPPONENT') {
    return { reason: 'un reflejo de dano solo esta definido sobre el oponente.' }
  }

  if (!effect.hasActivationCondition) {
    return {
      reason: 'un reflejo de dano exige su condicion de activacion declarada (contrato §6).',
    }
  }

  if (effect.durationTurns !== undefined) {
    return {
      reason: 'un reflejo de dano no tiene una duracion propia (usa la memoria de 1 turno).',
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
      reason: `la magnitud de un reflejo de dano debe ser PERCENTAGE entre 1 y ${String(MAX_HEALING_BASIS_POINTS)} puntos base.`,
    }
  }

  return { family: 'REFLECT', basisPoints: magnitude.basisPoints }
}

const classifyImmunity = (
  effect: CombatAbilityEffect,
): EffectClass | { readonly reason: string } => {
  if (effect.target !== 'SELF') {
    return { reason: 'una inmunidad solo esta definida sobre uno mismo.' }
  }

  if (effect.hasActivationCondition) {
    return {
      reason: 'un efecto condicionado no se evalua: la condicion no esta definida formalmente.',
    }
  }

  if (effect.magnitude !== undefined) {
    return { reason: 'una inmunidad no lleva magnitud (contrato §5).' }
  }

  if (typeof effect.immunityCode !== 'string' || effect.immunityCode.trim().length === 0) {
    return { reason: 'una inmunidad necesita su codigo (immunityCode) formalmente declarado.' }
  }

  return {
    family: 'IMMUNITY',
    immunityCode: effect.immunityCode,
    durationTurns: effect.durationTurns ?? null,
  }
}

/** Clasifica UN efecto en uno de los patrones soportados, o el motivo por el que ninguno lo acepta. */
const classifyEffect = (effect: CombatAbilityEffect): EffectClass | { readonly reason: string } => {
  switch (effect.kind) {
    case 'STAT_MODIFIER':
      return classifyStatModifier(effect)
    case 'DAMAGE':
      return classifyDirectDamage(effect)
    case 'REFLECT_DAMAGE':
      return classifyReflectDamage(effect)
    case 'IMMUNITY':
      return classifyImmunity(effect)
    default:
      return { reason: `el efecto ${effect.kind} no tiene una semantica formalmente definida.` }
  }
}

/**
 * Evalua una habilidad de UN unico efecto `REVIVE` (v1, sin cambios). Cualquier otra forma (mas
 * de un efecto, objetivo distinto de `ALLY`, duracion, condicion, magnitud fuera de `PERCENTAGE`
 * 1..10000) se rechaza explicitamente.
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

export const evaluateSkill = (ability: CombatAbility): SkillSupport => {
  if (ability.effects.length === 0) {
    return unsupported('la habilidad no declara ningun efecto.')
  }

  if (ability.effects.some((effect) => effect.kind === 'REVIVE')) {
    return evaluateHealSkill(ability.effects)
  }

  const classified: EffectClass[] = []

  for (const effect of ability.effects) {
    const result = classifyEffect(effect)

    if ('reason' in result) {
      return unsupported(result.reason)
    }

    classified.push(result)
  }

  const directDamage = classified.filter(
    (item): item is Extract<EffectClass, { family: 'DIRECT_DAMAGE' }> =>
      item.family === 'DIRECT_DAMAGE',
  )
  const instantHeal = classified.filter(
    (item): item is Extract<EffectClass, { family: 'INSTANT_HEAL' }> =>
      item.family === 'INSTANT_HEAL',
  )
  const temporalHeal = classified.filter(
    (item): item is Extract<EffectClass, { family: 'TEMPORAL_HEAL' }> =>
      item.family === 'TEMPORAL_HEAL',
  )
  const instantStat = classified.filter(
    (item): item is Extract<EffectClass, { family: 'INSTANT_STAT' }> =>
      item.family === 'INSTANT_STAT',
  )
  const temporalStat = classified.filter(
    (item): item is Extract<EffectClass, { family: 'TEMPORAL_STAT' }> =>
      item.family === 'TEMPORAL_STAT',
  )
  const reflect = classified.filter(
    (item): item is Extract<EffectClass, { family: 'REFLECT' }> => item.family === 'REFLECT',
  )
  const immunity = classified.filter(
    (item): item is Extract<EffectClass, { family: 'IMMUNITY' }> => item.family === 'IMMUNITY',
  )

  const isHealing = instantHeal.length > 0 || temporalHeal.length > 0
  const isOffensive =
    instantStat.length > 0 || temporalStat.length > 0 || reflect.length > 0 || immunity.length > 0

  if (directDamage.length > 0) {
    if (isHealing || isOffensive) {
      return unsupported(
        'un dano directo no se combina con otros patrones (no se aplica a medias).',
      )
    }

    return {
      supported: true,
      kind: 'DIRECT_DAMAGE',
      damageBonus: aggregate(directDamage.map((d) => d.bonus)),
    }
  }

  if (isHealing) {
    if (isOffensive) {
      return unsupported(
        'una sanacion no se combina con patrones ofensivos (no se aplica a medias).',
      )
    }

    const audience = [...instantHeal, ...temporalHeal].some(
      (item) => item.audience === 'ALLIED_GROUP',
    )
      ? 'ALLIED_GROUP'
      : 'ALLY'

    return {
      supported: true,
      kind: 'HEALING',
      audience,
      healBonus: aggregate(instantHeal.map((h) => h.bonus)),
      temporalEffects: temporalHeal.map((h) => ({
        family: 'STAT',
        statistic: 'HEALING',
        operation: 'INCREASE',
        audience: h.audience,
        bonus: h.bonus,
        durationTurns: h.durationTurns,
      })),
    }
  }

  if (reflect.length > 1) {
    return unsupported('mas de un reflejo de dano por habilidad no esta definido.')
  }

  const temporalEffects: TemporalEffectTemplate[] = [
    ...temporalStat.map((item): TemporalEffectTemplate => ({
      family: 'STAT',
      statistic: item.statistic,
      operation: item.operation,
      audience: item.audience,
      bonus: item.bonus,
      durationTurns: item.durationTurns,
    })),
    ...immunity.map((item): TemporalEffectTemplate => ({
      family: 'IMMUNITY',
      immunityCode: item.immunityCode,
      durationTurns: item.durationTurns,
    })),
  ]

  return {
    supported: true,
    kind: 'DAMAGE',
    attackBonus: aggregate(instantStat.filter((s) => s.statistic === 'ATTACK').map((s) => s.bonus)),
    damageBonus: aggregate(instantStat.filter((s) => s.statistic === 'DAMAGE').map((s) => s.bonus)),
    reflect: reflect[0] === undefined ? null : { basisPoints: reflect[0].basisPoints },
    temporalEffects,
  }
}
