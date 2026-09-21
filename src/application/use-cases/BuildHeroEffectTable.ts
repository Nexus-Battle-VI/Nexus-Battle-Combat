import { InvalidProbabilityModifierError } from '../../domain/errors/RandomEffectErrors'
import { baseEffectTableFor } from '../../domain/random-effects/BaseEffectProfiles'
import type { EffectControlTable } from '../../domain/random-effects/EffectControlTable'
import { ProbabilityModifier } from '../../domain/random-effects/ProbabilityModifier'
import { RandomEffectType } from '../../domain/random-effects/RandomEffectType'
import { parseHeroSubtype, type HeroSubtype } from '../../domain/value-objects/HeroSubtype'
import { PlayerWithoutEquippedHeroError } from '../errors/UpstreamErrors'
import type {
  EquippedHero,
  EquippedHeroEffect,
  PlayerInventoryEquippedHeroPort,
} from '../ports/PlayerInventoryEquippedHeroPort'

/**
 * Que hizo Combat con un efecto de equipamiento respecto a la TABLA de efectos
 * aleatorios de HU-25 y al ataque de HU-20. Cada efecto recibido tiene
 * exactamente uno: ninguno se aplica ni se descarta en silencio.
 *
 *  - `APPLIED_TO_TABLE`: modifico la tabla DEL PORTADOR. Hoy solo lo hace
 *    `CRITICAL_CHANCE INCREASE PERCENTAGE` incondicional, permanente y sobre uno
 *    mismo (ver `assessEquipmentEffect`). Lleva el `ProbabilityModifier` que se
 *    aplico.
 *  - `AFFECTS_ATTACKERS`: efecto del portador que modifica al heroe que LO ATACA
 *    (`target = OPPONENT`): «-2 % de critico al ataque del oponente» o «-1 al
 *    ataque del oponente». NO cambia la tabla ni el Ataque del portador; lo
 *    aplica `prepareAttack` cuando el portador es el objetivo de un golpe. Lleva
 *    su `adjustment`.
 *  - `REFLECTED_IN_STATS`: ya esta dentro de `effectiveStats` (Player-Inventory
 *    lo marca `appliedToStats`). Ignorado A PROPOSITO para no aplicarlo dos
 *    veces.
 *  - `NOT_A_TABLE_MODIFIER`: efecto conocido que NO es una probabilidad de la
 *    tabla ni una estadistica del golpe (dano, sanacion, inmunidad...). No
 *    modifica la tabla; su semantica pertenece a otras historias (HU-18, HU-19,
 *    HU-31...).
 *  - `PENDING_DEFINITION`: podria modificar la tabla o el golpe, pero el
 *    requisito no define como. NO se aplica y se declara, con sus motivos.
 *    Tambien cae aqui todo efecto que esta version de Combat no reconoce.
 */
export const EquipmentEffectOutcome = Object.freeze({
  AppliedToTable: 'APPLIED_TO_TABLE',
  AffectsAttackers: 'AFFECTS_ATTACKERS',
  ReflectedInStats: 'REFLECTED_IN_STATS',
  NotATableModifier: 'NOT_A_TABLE_MODIFIER',
  PendingDefinition: 'PENDING_DEFINITION',
} as const)

export type EquipmentEffectOutcome =
  (typeof EquipmentEffectOutcome)[keyof typeof EquipmentEffectOutcome]

/**
 * Por que un efecto queda pendiente. Se listan TODOS los que aplican: cuando
 * el primero se resuelva, los demas siguen diciendo que mas falta.
 *
 *  - `CRITICAL_CHANCE_UNIT_UNDEFINED`: `CRITICAL_CHANCE` con una magnitud que no
 *    es `PERCENTAGE` (`FIXED`, `DICE` o ausente): ningun requisito dice en que
 *    unidad de probabilidad estaria.
 *  - `CRITICAL_CHANCE_NOT_ROW_ALIGNED`: `PERCENTAGE` cuyos puntos basicos no son
 *    un numero exacto de filas (1 fila = 1,25 pb, asi que solo valen multiplos de
 *    5 pb) o no son un entero >= 0. No se redondea.
 *  - `CRITICAL_CHANCE_ALREADY_IN_STATS_INCONSISTENT`: `CRITICAL_CHANCE` marcado
 *    `appliedToStats`. `effectiveStats` no tiene ningun campo de critico, asi que
 *    es una contradiccion del contrato: ni se da por consolidado ni se aplica.
 *  - `ACTIVATION_CONDITION_UNEVALUATED`: hay una condicion y nadie define
 *    cuando se evalua; no se trata como bonus permanente. Evaluarla exige el
 *    estado de la batalla (turnos, estadisticas del oponente), que Combat aun no
 *    tiene.
 *  - `TEMPORARY_EFFECT_UNDEFINED`: tiene duracion; HU-25 solo modela una tabla
 *    vigente, no efectos que caducan por turnos (necesitan el contador de turnos
 *    de la batalla).
 *  - `NON_SELF_TARGET_UNDEFINED`: apunta a otro participante y no es el caso
 *    definido (el critico dirigido al oponente solo se define como disminucion).
 *  - `OPERATION_UNDEFINED`: una operacion que el documento no define para ese
 *    objetivo: sobre uno mismo solo hay incrementos («todo incremento de
 *    probabilidad»); contra el oponente, solo disminuciones.
 *  - `OPPONENT_STAT_EFFECT_UNDEFINED`: efecto dirigido al oponente sobre una
 *    estadistica del golpe cuya forma el documento no define: solo se define
 *    `ATTACK DECREASE FIXED` («-1 al ataque del oponente»); un porcentaje, un
 *    dado, un aumento o un efecto sobre la Defensa no.
 *  - `UNRECOGNIZED_EFFECT`: esta version de Combat no conoce el efecto. No se
 *    reinterpreta ni se da por irrelevante.
 */
export const PendingReason = Object.freeze({
  CriticalChanceUnitUndefined: 'CRITICAL_CHANCE_UNIT_UNDEFINED',
  CriticalChanceNotRowAligned: 'CRITICAL_CHANCE_NOT_ROW_ALIGNED',
  CriticalChanceAlreadyInStatsInconsistent: 'CRITICAL_CHANCE_ALREADY_IN_STATS_INCONSISTENT',
  ActivationConditionUnevaluated: 'ACTIVATION_CONDITION_UNEVALUATED',
  TemporaryEffectUndefined: 'TEMPORARY_EFFECT_UNDEFINED',
  NonSelfTargetUndefined: 'NON_SELF_TARGET_UNDEFINED',
  OperationUndefined: 'OPERATION_UNDEFINED',
  OpponentStatEffectUndefined: 'OPPONENT_STAT_EFFECT_UNDEFINED',
  UnrecognizedEffect: 'UNRECOGNIZED_EFFECT',
} as const)

export type PendingReason = (typeof PendingReason)[keyof typeof PendingReason]

/**
 * Lo que un efecto `AFFECTS_ATTACKERS` le hace al heroe que ataca a su portador:
 *
 *  - `CRITICAL_CHANCE`: le quita filas de critico a su tabla (que vuelven a «no
 *    causar dano»).
 *  - `ATTACK`: le resta puntos a su Ataque.
 */
export type AttackerAdjustment =
  | { readonly statistic: 'CRITICAL_CHANCE'; readonly reduction: ProbabilityModifier }
  | { readonly statistic: 'ATTACK'; readonly points: number }

export interface EquipmentEffectAssessment {
  readonly effect: EquippedHeroEffect
  readonly outcome: EquipmentEffectOutcome
  /** Vacio salvo en `PENDING_DEFINITION`. */
  readonly reasons: readonly PendingReason[]
  /** Solo en `APPLIED_TO_TABLE`: el incremento que se aplico a la tabla. */
  readonly modifier?: ProbabilityModifier
  /** Solo en `AFFECTS_ATTACKERS`: lo que le hace al heroe que ataca al portador. */
  readonly adjustment?: AttackerAdjustment
}

const STAT_MODIFIER = 'STAT_MODIFIER'
const CRITICAL_CHANCE = 'CRITICAL_CHANCE'
const ATTACK = 'ATTACK'
const DEFENSE = 'DEFENSE'
const SELF = 'SELF'
const OPPONENT = 'OPPONENT'
const INCREASE = 'INCREASE'
const DECREASE = 'DECREASE'

/**
 * Vocabulario CONOCIDO de Catalog v1 que no es una probabilidad de la tabla.
 * Es una lista cerrada a proposito: un valor que no este aqui (una estadistica
 * o un `kind` nuevo) NO se presume irrelevante -- queda pendiente -- porque
 * podria ser justo una probabilidad que si modifica la tabla.
 */
const NON_TABLE_STATISTICS: ReadonlySet<string> = new Set([
  'POWER',
  'HEALTH',
  'DEFENSE',
  'ATTACK',
  'DAMAGE',
  'HEALING',
])

const NON_TABLE_KINDS: ReadonlySet<string> = new Set([
  'DAMAGE',
  'HEALING',
  'IMMUNITY',
  'REFLECT_DAMAGE',
  'REVIVE',
  'TEMPORARY_STATUS',
])

const isKnownNonTableEffect = (effect: EquippedHeroEffect): boolean =>
  effect.kind === STAT_MODIFIER
    ? effect.statistic !== undefined && NON_TABLE_STATISTICS.has(effect.statistic)
    : NON_TABLE_KINDS.has(effect.kind)

/**
 * `PERCENTAGE` de `CRITICAL_CHANCE` -> cantidad de filas de la tabla. Regla LOCAL
 * a la tabla de HU-25 (Tabla 23: 5 % + 6 % = 11 %): los puntos basicos son
 * PUNTOS PORCENTUALES ABSOLUTOS de probabilidad (100 pb = 1 pp = 80 filas). NO
 * redefine `PERCENTAGE` para ninguna otra estadistica.
 *
 * Devuelve `undefined` si los puntos basicos no equivalen a un numero exacto de
 * filas; la conversion (y su rechazo) es de `ProbabilityModifier`.
 */
const criticalChanceModifier = (basisPoints: number): ProbabilityModifier | undefined => {
  try {
    return ProbabilityModifier.ofBasisPoints(RandomEffectType.CriticalDamage, basisPoints)
  } catch (error) {
    if (error instanceof InvalidProbabilityModifierError) {
      return undefined
    }

    throw error
  }
}

/**
 * Las dos formas de `CRITICAL_CHANCE` que el documento define: un incremento
 * sobre uno mismo («+3 % de critico al ataque») y una disminucion sobre el
 * oponente («-2 % de critico al ataque del oponente», Baculo de Permafrost).
 */
const isSelfIncrease = (effect: EquippedHeroEffect): boolean =>
  effect.target === SELF && effect.operation === INCREASE

const isOpponentDecrease = (effect: EquippedHeroEffect): boolean =>
  effect.target === OPPONENT && effect.operation === DECREASE

const criticalChanceBlockers = (
  effect: EquippedHeroEffect,
  modifier: ProbabilityModifier | undefined,
): readonly PendingReason[] => [
  ...(effect.magnitude?.mode === 'PERCENTAGE' ? [] : [PendingReason.CriticalChanceUnitUndefined]),
  ...(effect.magnitude?.mode === 'PERCENTAGE' && modifier === undefined
    ? [PendingReason.CriticalChanceNotRowAligned]
    : []),
  ...(effect.appliedToStats ? [PendingReason.CriticalChanceAlreadyInStatsInconsistent] : []),
  ...(effect.hasActivationCondition ? [PendingReason.ActivationConditionUnevaluated] : []),
  ...(effect.durationTurns === undefined ? [] : [PendingReason.TemporaryEffectUndefined]),
  ...(isSelfIncrease(effect) || isOpponentDecrease(effect)
    ? []
    : [
        ...(effect.target === SELF ? [] : [PendingReason.NonSelfTargetUndefined]),
        ...(effect.operation === INCREASE ? [] : [PendingReason.OperationUndefined]),
      ]),
]

/**
 * Puntos que un efecto `ATTACK` dirigido al oponente le resta al Ataque de
 * quien ataca al portador. Solo se define `DECREASE FIXED` («-1 al ataque del
 * oponente», Vision borrosa) con una cantidad entera no negativa: un porcentaje
 * necesitaria la base de OTRO heroe, un dado no es un valor y un aumento del
 * Ataque del oponente no existe en el documento.
 */
const attackReductionPoints = (effect: EquippedHeroEffect): number | undefined => {
  if (effect.operation !== DECREASE || effect.magnitude?.mode !== 'FIXED') {
    return undefined
  }

  const { amount } = effect.magnitude

  return Number.isInteger(amount) && amount >= 0 ? amount : undefined
}

const opponentStatBlockers = (
  effect: EquippedHeroEffect,
  supported: boolean,
): readonly PendingReason[] => [
  ...(supported ? [] : [PendingReason.OpponentStatEffectUndefined]),
  ...(effect.hasActivationCondition ? [PendingReason.ActivationConditionUnevaluated] : []),
  ...(effect.durationTurns === undefined ? [] : [PendingReason.TemporaryEffectUndefined]),
]

/**
 * Clasifica un efecto de equipamiento respecto a la tabla de HU-25 y al ataque
 * de HU-20. Pura y sin estado.
 *
 * Solo dos formas de `CRITICAL_CHANCE` modifican una tabla, ambas
 * `PERCENTAGE`, permanentes, sin condicion de activacion y sin `appliedToStats`:
 *
 *  - `INCREASE` sobre `SELF` -> `APPLIED_TO_TABLE` (+ `ProbabilityModifier`).
 *  - `DECREASE` sobre `OPPONENT` -> `AFFECTS_ATTACKERS` (- `ProbabilityModifier`
 *    que `prepareAttack` resta de la tabla de quien ataca al portador).
 *
 * Y una forma de `ATTACK` altera el golpe: `DECREASE FIXED` sobre `OPPONENT` ->
 * `AFFECTS_ATTACKERS` (puntos que se restan al Ataque de quien ataca al portador).
 * Cualquier otra variante (SET, MULTIPLY, BLOCK, FIXED, DICE, condicionada,
 * temporal, hacia otro objetivo...) queda PENDIENTE.
 *
 * El critico se evalua ANTES que `appliedToStats`: `effectiveStats` no tiene
 * ningun campo de critico, asi que un `CRITICAL_CHANCE` marcado como ya
 * consolidado seria una contradiccion del contrato, y darlo por reflejado lo
 * ocultaria. Se declara pendiente en su lugar.
 */
export const assessEquipmentEffect = (effect: EquippedHeroEffect): EquipmentEffectAssessment => {
  if (effect.kind === STAT_MODIFIER && effect.statistic === CRITICAL_CHANCE) {
    const modifier =
      effect.magnitude?.mode === 'PERCENTAGE'
        ? criticalChanceModifier(effect.magnitude.basisPoints)
        : undefined
    const reasons = criticalChanceBlockers(effect, modifier)

    if (reasons.length === 0 && modifier !== undefined) {
      return isOpponentDecrease(effect)
        ? {
            effect,
            outcome: EquipmentEffectOutcome.AffectsAttackers,
            reasons,
            adjustment: { statistic: CRITICAL_CHANCE, reduction: modifier },
          }
        : { effect, outcome: EquipmentEffectOutcome.AppliedToTable, reasons, modifier }
    }

    return { effect, outcome: EquipmentEffectOutcome.PendingDefinition, reasons }
  }

  if (effect.appliedToStats) {
    return { effect, outcome: EquipmentEffectOutcome.ReflectedInStats, reasons: [] }
  }

  if (
    effect.kind === STAT_MODIFIER &&
    effect.target === OPPONENT &&
    (effect.statistic === ATTACK || effect.statistic === DEFENSE)
  ) {
    const points = effect.statistic === ATTACK ? attackReductionPoints(effect) : undefined
    const reasons = opponentStatBlockers(effect, points !== undefined)

    if (reasons.length === 0 && points !== undefined) {
      return {
        effect,
        outcome: EquipmentEffectOutcome.AffectsAttackers,
        reasons,
        adjustment: { statistic: ATTACK, points },
      }
    }

    return { effect, outcome: EquipmentEffectOutcome.PendingDefinition, reasons }
  }

  if (isKnownNonTableEffect(effect)) {
    return { effect, outcome: EquipmentEffectOutcome.NotATableModifier, reasons: [] }
  }

  return {
    effect,
    outcome: EquipmentEffectOutcome.PendingDefinition,
    reasons: [PendingReason.UnrecognizedEffect],
  }
}

/**
 * Tabla de control vigente de un heroe equipado, mas lo que Combat hizo con cada
 * efecto de su equipamiento.
 */
export interface HeroEffectTable {
  readonly heroId: string
  readonly subtype: HeroSubtype
  /**
   * La tabla del heroe cuando ATACA: la BASE del subtipo mas los incrementos de
   * `appliedEffects`. NO incluye lo que le quite el equipo de su objetivo (los
   * `AFFECTS_ATTACKERS` de OTRO heroe): eso lo resta `prepareAttack`. Si
   * `pendingEffects` no esta vacio, esta tabla NO incluye el efecto de esos
   * productos.
   */
  readonly table: EffectControlTable
  /** Una entrada por efecto recibido, en el orden del contrato. */
  readonly assessments: readonly EquipmentEffectAssessment[]
  /** Los efectos que modificaron la tabla (cada uno con su `modifier`). */
  readonly appliedEffects: readonly EquipmentEffectAssessment[]
  /**
   * Los efectos de ESTE heroe que alteran a quien lo ataca. No se aplican a su
   * propia tabla: los usa `prepareAttack` cuando este heroe es el objetivo.
   */
  readonly opponentEffects: readonly EquipmentEffectAssessment[]
  /** Los efectos ya incluidos en `effectiveStats`: no se aplican otra vez. */
  readonly reflectedInStatsEffects: readonly EquipmentEffectAssessment[]
  /** Los efectos conocidos que no son una probabilidad de la tabla. */
  readonly nonTableEffects: readonly EquipmentEffectAssessment[]
  /** Los efectos que podrian modificar la tabla o el golpe y NO se aplicaron. */
  readonly pendingEffects: readonly EquipmentEffectAssessment[]
}

/**
 * De un heroe equipado a su tabla de efectos (HU-25):
 *
 *   subtype  ->  parseHeroSubtype  ->  baseEffectTableFor  ->  tabla base
 *   activeEffects  ->  assessEquipmentEffect  ->  ProbabilityModifier[]
 *   tabla base  ->  withModifiers(modifiers)  ->  tabla vigente
 *
 * Falla de forma EXPLICITA, sin inventar tabla:
 *  - subtipo fuera del registro `hero-subtypes-v1`: `DomainError`;
 *  - incrementos que suman mas que el «no causar dano» disponible:
 *    `InsufficientNoDamageProbabilityError` (no se recorta ni se redistribuye).
 *
 * Los ocho subtipos tienen tabla: Chaman y Medico usan «no causar dano» = 100 %
 * (ver `BASE_EFFECT_PERCENTAGES`).
 *
 * El apilamiento de varios incrementos es el aditivo de
 * `EffectControlTable.withModifiers`: no depende del orden. La tabla base es
 * inmutable y compartida: `withModifiers` devuelve una tabla NUEVA; ni ella ni
 * `activeEffects` se mutan.
 *
 * Pura y sin E/S: se prueba sin puerto ni generador, y no toca la aleatoriedad
 * (HU-24). No invoca `ResolveRandomEffect`: eso lo hace `ResolveAttack` (HU-20)
 * tras un golpe efectivo.
 */
/**
 * Lo que la tabla de efectos necesita de un heroe. `EquippedHero` (Player-Inventory)
 * y el perfil de combate congelado de HU-18 lo cumplen por estructura: HU-20 no se
 * duplica, solo deja de exigir el DTO completo del otro servicio.
 */
export type EffectTableSource = Pick<EquippedHero, 'heroId' | 'subtype' | 'activeEffects'>

export const buildHeroEffectTable = (hero: EffectTableSource): HeroEffectTable => {
  const subtype = parseHeroSubtype(hero.subtype)
  const assessments = hero.activeEffects.map(assessEquipmentEffect)
  const withOutcome = (outcome: EquipmentEffectOutcome): readonly EquipmentEffectAssessment[] =>
    assessments.filter((assessment) => assessment.outcome === outcome)
  const appliedEffects = withOutcome(EquipmentEffectOutcome.AppliedToTable)
  const modifiers = appliedEffects.flatMap(({ modifier }) =>
    modifier === undefined ? [] : [modifier],
  )

  return {
    heroId: hero.heroId,
    subtype,
    table: baseEffectTableFor(subtype).withModifiers(modifiers),
    assessments,
    appliedEffects,
    opponentEffects: withOutcome(EquipmentEffectOutcome.AffectsAttackers),
    reflectedInStatsEffects: withOutcome(EquipmentEffectOutcome.ReflectedInStats),
    nonTableEffects: withOutcome(EquipmentEffectOutcome.NotATableModifier),
    pendingEffects: withOutcome(EquipmentEffectOutcome.PendingDefinition),
  }
}

/**
 * `playerId -> heroe equipado real -> tabla vigente` (HU-25, RF-25).
 *
 * Pide el heroe a Player-Inventory por el puerto (el `playerId` es siempre
 * `identity.subject`) y construye su tabla. Sin heroe equipado (`null`) lanza
 * `PlayerWithoutEquippedHeroError`, igual que `JoinBattleRoom`: no se inventa un
 * heroe por defecto.
 *
 * Sin consumidor de produccion todavia: no se registra en `app.module.ts` hasta
 * que exista el flujo de batalla (HU-17, HU-18) que llame a `prepareAttack`.
 */
export class BuildHeroEffectTable {
  constructor(private readonly equippedHeroes: PlayerInventoryEquippedHeroPort) {}

  async execute(playerId: string): Promise<HeroEffectTable> {
    const hero = await this.equippedHeroes.getEquippedHero(playerId)

    if (hero === null) {
      throw new PlayerWithoutEquippedHeroError(playerId)
    }

    return buildHeroEffectTable(hero)
  }
}
