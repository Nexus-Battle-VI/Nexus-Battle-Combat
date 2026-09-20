import { baseEffectTableFor } from '../../domain/random-effects/BaseEffectProfiles'
import type { EffectControlTable } from '../../domain/random-effects/EffectControlTable'
import { parseHeroSubtype, type HeroSubtype } from '../../domain/value-objects/HeroSubtype'
import { PlayerWithoutEquippedHeroError } from '../errors/UpstreamErrors'
import type {
  EquippedHero,
  EquippedHeroEffect,
  PlayerInventoryEquippedHeroPort,
} from '../ports/PlayerInventoryEquippedHeroPort'

/**
 * Que hizo Combat con un efecto de equipamiento respecto a la TABLA de efectos
 * aleatorios de HU-25. Cada efecto recibido tiene exactamente uno: ninguno se
 * aplica ni se descarta en silencio.
 *
 *  - `REFLECTED_IN_STATS`: ya esta dentro de `effectiveStats` (Player-Inventory
 *    lo marca `appliedToStats`). Ignorado A PROPOSITO para no aplicarlo dos
 *    veces.
 *  - `NOT_A_TABLE_MODIFIER`: efecto conocido que NO es una probabilidad de la
 *    tabla (estadisticas numericas, dano, sanacion, inmunidad...). No modifica
 *    la tabla; su semantica pertenece a otras historias (HU-20, HU-31...).
 *  - `PENDING_DEFINITION`: podria modificar la tabla, pero el requisito no
 *    define como. NO se aplica y se declara, con sus motivos. Tambien cae aqui
 *    todo efecto que esta version de Combat no reconoce.
 *
 * NO EXISTE un resultado `APPLIED`: hoy ningun efecto tiene una semantica
 * formal que lo traduzca a un `ProbabilityModifier` (ver `PendingReason`).
 * Anadirlo sin esa regla seria inventarla.
 */
export const EquipmentEffectOutcome = Object.freeze({
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
 *  - `CRITICAL_CHANCE_UNIT_UNDEFINED`: `CRITICAL_CHANCE` con `PERCENTAGE 300 pb`
 *    no dice si son +3 PUNTOS PORCENTUALES ABSOLUTOS (como el «+6 %» de la
 *    Tabla 23, que `ProbabilityModifier.ofBasisPoints` interpreta asi) o un
 *    +3 % RELATIVO al critico base. Ningun requisito lo define. Aplica a
 *    cualquier magnitud (`FIXED` tampoco dice en que unidad esta).
 *  - `ACTIVATION_CONDITION_UNEVALUATED`: hay una condicion y nadie define
 *    cuando se evalua; no se trata como bonus permanente.
 *  - `TEMPORARY_EFFECT_UNDEFINED`: tiene duracion; HU-25 solo modela una tabla
 *    vigente, no efectos que caducan por turnos.
 *  - `NON_SELF_TARGET_UNDEFINED`: apunta a otro participante; como afecta a la
 *    tabla de ESE participante no esta definido.
 *  - `OPERATION_UNDEFINED`: HU-25 solo define incrementos («todo incremento de
 *    probabilidad»); una disminucion, un multiplicador o un valor fijo no.
 *  - `UNRECOGNIZED_EFFECT`: esta version de Combat no conoce el efecto. No se
 *    reinterpreta ni se da por irrelevante.
 */
export const PendingReason = Object.freeze({
  CriticalChanceUnitUndefined: 'CRITICAL_CHANCE_UNIT_UNDEFINED',
  ActivationConditionUnevaluated: 'ACTIVATION_CONDITION_UNEVALUATED',
  TemporaryEffectUndefined: 'TEMPORARY_EFFECT_UNDEFINED',
  NonSelfTargetUndefined: 'NON_SELF_TARGET_UNDEFINED',
  OperationUndefined: 'OPERATION_UNDEFINED',
  UnrecognizedEffect: 'UNRECOGNIZED_EFFECT',
} as const)

export type PendingReason = (typeof PendingReason)[keyof typeof PendingReason]

export interface EquipmentEffectAssessment {
  readonly effect: EquippedHeroEffect
  readonly outcome: EquipmentEffectOutcome
  /** Vacio salvo en `PENDING_DEFINITION`. */
  readonly reasons: readonly PendingReason[]
}

const STAT_MODIFIER = 'STAT_MODIFIER'
const CRITICAL_CHANCE = 'CRITICAL_CHANCE'

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

const criticalChanceBlockers = (effect: EquippedHeroEffect): readonly PendingReason[] => [
  PendingReason.CriticalChanceUnitUndefined,
  ...(effect.hasActivationCondition ? [PendingReason.ActivationConditionUnevaluated] : []),
  ...(effect.durationTurns === undefined ? [] : [PendingReason.TemporaryEffectUndefined]),
  ...(effect.target === 'SELF' ? [] : [PendingReason.NonSelfTargetUndefined]),
  ...(effect.operation === 'INCREASE' ? [] : [PendingReason.OperationUndefined]),
]

/**
 * Clasifica un efecto de equipamiento respecto a la tabla de HU-25. Pura y sin
 * estado. Es la UNICA decision de Combat sobre efectos de equipamiento en esta
 * fase, y no traduce ninguno: ver `EquipmentEffectOutcome`.
 *
 * El critico se evalua ANTES que `appliedToStats`: `effectiveStats` no tiene
 * ningun campo de critico, asi que un `CRITICAL_CHANCE` marcado como ya
 * consolidado seria una contradiccion del contrato, y darlo por reflejado lo
 * ocultaria. Se declara pendiente en su lugar.
 */
export const assessEquipmentEffect = (effect: EquippedHeroEffect): EquipmentEffectAssessment => {
  if (effect.kind === STAT_MODIFIER && effect.statistic === CRITICAL_CHANCE) {
    return {
      effect,
      outcome: EquipmentEffectOutcome.PendingDefinition,
      reasons: criticalChanceBlockers(effect),
    }
  }

  if (effect.appliedToStats) {
    return { effect, outcome: EquipmentEffectOutcome.ReflectedInStats, reasons: [] }
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
 * Tabla de control vigente de un heroe equipado, mas lo que Combat NO pudo
 * reflejar en ella.
 */
export interface HeroEffectTable {
  readonly heroId: string
  readonly subtype: HeroSubtype
  /**
   * La tabla que HU-20 debe usar. HOY es la tabla BASE del subtipo, sin
   * modificadores: ver `buildHeroEffectTable`. Si `pendingEffects` no esta
   * vacio, esta tabla NO incluye el efecto de esos productos.
   */
  readonly table: EffectControlTable
  /** Una entrada por efecto recibido, en el orden del contrato. */
  readonly assessments: readonly EquipmentEffectAssessment[]
  /** Los efectos que podrian modificar la tabla y NO se aplicaron. */
  readonly pendingEffects: readonly EquipmentEffectAssessment[]
}

/**
 * De un heroe equipado a su tabla de efectos (HU-25):
 *
 *   subtype  ->  parseHeroSubtype  ->  baseEffectTableFor  ->  tabla base
 *   activeEffects  ->  assessEquipmentEffect  ->  que se aplico y que queda pendiente
 *
 * Falla de forma EXPLICITA, sin inventar tabla:
 *  - subtipo fuera del registro `hero-subtypes-v1`: `DomainError`;
 *  - `CHAMAN` / `MEDICO`: `UnsupportedHeroEffectProfileError` (la Tabla 21 no
 *    les da una distribucion valida; no se inventa una).
 *
 * LA TABLA VIGENTE ES LA BASE. Ningun efecto de equipamiento se traduce hoy a
 * un `ProbabilityModifier` porque ninguno tiene una semantica formalmente
 * definida (ver `PendingReason`). Cuando una regla aprobada traduzca alguno, el
 * cambio es UN punto: aplicar aqui `table.withModifiers(...)`. Mientras tanto
 * el resultado no finge: `pendingEffects` dice que efectos no estan en la tabla.
 *
 * Pura y sin E/S: se prueba sin puerto ni generador, y no toca la aleatoriedad
 * (HU-24). No invoca `ResolveRandomEffect`: eso lo hara HU-20 tras un golpe
 * efectivo.
 */
export const buildHeroEffectTable = (hero: EquippedHero): HeroEffectTable => {
  const subtype = parseHeroSubtype(hero.subtype)
  const table = baseEffectTableFor(subtype)
  const assessments = hero.activeEffects.map(assessEquipmentEffect)

  return {
    heroId: hero.heroId,
    subtype,
    table,
    assessments,
    pendingEffects: assessments.filter(
      (assessment) => assessment.outcome === EquipmentEffectOutcome.PendingDefinition,
    ),
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
 * Sin consumidor todavia: no se registra en `app.module.ts` hasta que HU-20
 * defina el flujo de batalla que lo invoque (mismo criterio que
 * `ResolveRandomEffect`).
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
