import { InvalidCombatProfileError } from '../errors/BattleErrors'

/**
 * Perfil de combate CONGELADO de un participante (HU-18, contrato v1 de
 * Infrastructure): lo minimo que Combat necesita para resolver golpes sin volver
 * a consultar Player-Inventory ni Catalog.
 *
 * Es un modelo LOCAL: espeja los campos que HU-20 lee de `EquippedHero`, pero no
 * importa ningun tipo de otro servicio (ADR-001) y NO copia el inventario, el
 * nombre del heroe, su referencia ni la fecha de seleccion. Se construye una vez
 * al iniciar la batalla (`StartBattle`, con la respuesta que ya se pidio para
 * revalidar HU-16) y no cambia durante ella: cambiar el equipo despues no
 * modifica la batalla.
 *
 * HU-19 lo amplia de forma ADITIVA con el Poder maximo y las habilidades del heroe
 * (contrato `hu-19-skills-v1`, §5.1): tambien se congelan. Son OPCIONALES porque un
 * perfil escrito antes de HU-19 no los tiene y se restaura sin estado de habilidades.
 */
export type CombatMagnitude =
  | { readonly mode: 'FIXED'; readonly amount: number }
  | { readonly mode: 'PERCENTAGE'; readonly basisPoints: number }
  | { readonly mode: 'DICE'; readonly count: number; readonly sides: number }

/**
 * Efecto de equipamiento tal como lo necesita HU-20 (`prepareAttack` y
 * `buildHeroEffectTable`): el efecto propio que altera la tabla y lo que el equipo
 * del objetivo le resta al atacante. Mismos campos que el contrato de
 * Player-Inventory; los efectos temporales o condicionados del equipamiento se
 * conservan pero ni HU-18 ni HU-19 los aplican (pendiente, `hu-19-skills-v1` §16).
 */
export interface CombatEffect {
  readonly sourceProductId: string
  readonly sourceProductReference: string
  readonly kind: string
  readonly target: string
  readonly statistic?: string
  readonly operation?: string
  readonly magnitude?: CombatMagnitude
  readonly durationTurns?: number
  readonly hasActivationCondition: boolean
  readonly appliedToStats: boolean
}

/** Costo de Poder de una habilidad, tal como lo publica Catalog v1 (Tabla 7). */
export type CombatPowerCost =
  { readonly mode: 'FIXED'; readonly amount: number } | { readonly mode: 'ALL_AVAILABLE' }

/**
 * Efecto de UNA habilidad tal como Player-Inventory lo publica en `abilities[].effects`
 * (HU-19). `kind`, `target`, `statistic` y `operation` viajan como texto: el vocabulario
 * es de Catalog y puede crecer. Que efecto sabe ejecutar Combat lo decide
 * `evaluateSkill`; lo demas se rechaza de forma explicita.
 */
export interface CombatAbilityEffect {
  readonly kind: string
  readonly target: string
  readonly statistic?: string
  readonly operation?: string
  readonly magnitude?: CombatMagnitude
  readonly durationTurns?: number
  readonly hasActivationCondition: boolean
  /**
   * HU-19 v2 (contrato §5): codigo de la inmunidad para `kind: 'IMMUNITY'`. Estructural,
   * sin `magnitude` (no se amplia ese esquema): el campo ya existe en
   * `catalog-product-v1.openapi.yaml`. Ausente en cualquier otro `kind`.
   */
  readonly immunityCode?: string
}

/**
 * Habilidad especial congelada de un heroe (HU-19, Tabla 7). `abilityId` es el
 * `productId` de Catalog: el identificador que el cliente envia en `useSkill`.
 * `chargeTurns` son los turnos propios de recarga tras usarla.
 */
export interface CombatAbility {
  readonly abilityId: string
  readonly name: string
  readonly powerCost: CombatPowerCost
  readonly chargeTurns: number
  readonly effects: readonly CombatAbilityEffect[]
}

/**
 * Epica equipada CONGELADA (HU-31, contrato `hu-31-equipped-epic-v1` §8).
 *
 * Espejo local de `EquippedHeroEpic` (`PlayerInventoryEquippedHeroPort.ts`),
 * ya resuelta por Player-Inventory (`applyEpicEffects`, sin reimplementar el
 * resolver aqui). Combat solo la transporta: `baseEffect`/`specificEffect`
 * son objetos OPACOS, igual criterio que `CombatAbilityEffect`, y
 * `applied.*` es lo que de verdad importa para el snapshot -- el resultado ya
 * resuelto segun el subtipo real del heroe en el momento del inicio de la
 * batalla, que no cambia aunque la epica equipada cambie despues (HU-29/HU-31
 * §9: cambios posteriores a este congelamiento no afectan la batalla ya
 * iniciada).
 *
 * NO es una habilidad ejecutable: no tiene `powerCost` ni `chargeTurns`, y
 * `UseSkill`/`SkillEffectPolicy`/`SkillRealtimeHandler` no la leen (eso sigue
 * bloqueado, ver `docs/hu-19-skills.md` §"Epica").
 */
export interface CombatEpic {
  readonly epicProductId: string
  readonly epicReference: string
  readonly name: string
  readonly compatibleHeroSubtype: string
  readonly baseEffect: Readonly<Record<string, unknown>> | null
  readonly specificEffect: Readonly<Record<string, unknown>>
  readonly applied: {
    readonly baseApplied: Readonly<Record<string, unknown>> | null
    readonly additionalApplied: Readonly<Record<string, unknown>> | null
  }
}

export interface CombatProfile {
  readonly heroId: string
  /** Codigo de subtipo (`hero-subtypes-v1`), tal como lo publica Player-Inventory. */
  readonly subtype: string
  readonly maxHealth: number
  /** `null`: el heroe no tiene Ataque numerico (sanadores). */
  readonly attack: number | null
  readonly defense: number
  /** `null`: el heroe no tiene Dano (sanadores). */
  readonly damage: CombatMagnitude | null
  readonly activeEffects: readonly CombatEffect[]
  /** HU-19: Poder maximo (`effectiveStats.power`). Ausente en un perfil anterior a HU-19. */
  readonly maxPower?: number
  /**
   * HU-08 (CA-06): nivel del heroe (`1..8`), tal como lo publica Player-Inventory.
   * Multiplica el RESULTADO FINAL de la magnitud de Dano del heroe (opcion A,
   * ver `applyLevelToMagnitudeResult`). `effectiveStats` ya incorpora el nivel en
   * las estadisticas numericas (Ataque, Defensa, Vida, Poder); el Dano es una
   * magnitud con dados que solo Combat puede resolver, asi que el nivel viaja
   * aparte. Ausente en un perfil anterior a CA-06: se trata como nivel 1.
   */
  readonly level?: number
  /** HU-19: habilidades del heroe, en el orden de Catalog. Ausente en un perfil anterior a HU-19. */
  readonly abilities?: readonly CombatAbility[]
  /** HU-31: epica equipada congelada. Ausente cuando el heroe no tiene ninguna. */
  readonly epic?: CombatEpic
}

/** Un identificador de habilidad es una clave de documento: sin puntos, `$` ni separadores. */
const ABILITY_ID = /^[A-Za-z0-9_-]{1,100}$/u
const MAX_CHARGE_TURNS = 100

const requireNonNegativeInteger = (value: number, field: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidCombatProfileError(
      `El perfil de combate necesita "${field}" como entero no negativo. Se recibio ${String(value)}.`,
    )
  }
}

const requireNonEmptyText = (value: unknown, field: string): void => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidCombatProfileError(`La habilidad necesita "${field}" como texto no vacio.`)
  }
}

const requireOptionalText = (value: unknown, field: string): void => {
  if (value !== undefined) {
    requireNonEmptyText(value, field)
  }
}

const validateMagnitude = (magnitude: CombatMagnitude, field: string): void => {
  switch (magnitude.mode) {
    case 'FIXED':
      requireNonNegativeInteger(magnitude.amount, `${field}.amount`)
      return
    case 'PERCENTAGE':
      requireNonNegativeInteger(magnitude.basisPoints, `${field}.basisPoints`)
      return
    case 'DICE':
      requireNonNegativeInteger(magnitude.count, `${field}.count`)
      requireNonNegativeInteger(magnitude.sides, `${field}.sides`)
      return
    default:
      throw new InvalidCombatProfileError(`La magnitud de "${field}" tiene un modo desconocido.`)
  }
}

const validateAbilityEffect = (effect: CombatAbilityEffect, field: string): CombatAbilityEffect => {
  requireNonEmptyText(effect.kind, `${field}.kind`)
  requireNonEmptyText(effect.target, `${field}.target`)
  requireOptionalText(effect.statistic, `${field}.statistic`)
  requireOptionalText(effect.operation, `${field}.operation`)
  requireOptionalText(effect.immunityCode, `${field}.immunityCode`)

  if (typeof effect.hasActivationCondition !== 'boolean') {
    throw new InvalidCombatProfileError(`"${field}.hasActivationCondition" debe ser booleano.`)
  }

  if (effect.magnitude !== undefined) {
    validateMagnitude(effect.magnitude, `${field}.magnitude`)
  }

  if (effect.durationTurns !== undefined) {
    requireNonNegativeInteger(effect.durationTurns, `${field}.durationTurns`)

    if (effect.durationTurns === 0) {
      throw new InvalidCombatProfileError(`"${field}.durationTurns" debe ser al menos 1.`)
    }
  }

  return Object.freeze({
    kind: effect.kind,
    target: effect.target,
    ...(effect.statistic === undefined ? {} : { statistic: effect.statistic }),
    ...(effect.operation === undefined ? {} : { operation: effect.operation }),
    ...(effect.magnitude === undefined
      ? {}
      : { magnitude: Object.freeze({ ...effect.magnitude }) }),
    ...(effect.durationTurns === undefined ? {} : { durationTurns: effect.durationTurns }),
    ...(effect.immunityCode === undefined ? {} : { immunityCode: effect.immunityCode }),
    hasActivationCondition: effect.hasActivationCondition,
  })
}

const validateAbility = (ability: CombatAbility, index: number): CombatAbility => {
  const field = `abilities[${String(index)}]`

  if (typeof ability.abilityId !== 'string' || !ABILITY_ID.test(ability.abilityId)) {
    throw new InvalidCombatProfileError(
      `La habilidad ${field} necesita un abilityId de 1 a 100 caracteres alfanumericos, "_" o "-".`,
    )
  }

  requireNonEmptyText(ability.name, `${field}.name`)

  const cost = ability.powerCost as CombatPowerCost | undefined

  if (cost?.mode === 'FIXED') {
    if (!Number.isInteger(cost.amount) || cost.amount < 1) {
      throw new InvalidCombatProfileError(`El costo fijo de ${field} debe ser un entero >= 1.`)
    }
  } else if (cost?.mode !== 'ALL_AVAILABLE') {
    throw new InvalidCombatProfileError(`El costo de Poder de ${field} tiene un modo invalido.`)
  }

  if (
    !Number.isInteger(ability.chargeTurns) ||
    ability.chargeTurns < 1 ||
    ability.chargeTurns > MAX_CHARGE_TURNS
  ) {
    throw new InvalidCombatProfileError(
      `La recarga de ${field} debe ser un entero entre 1 y ${String(MAX_CHARGE_TURNS)}.`,
    )
  }

  const rawEffects: unknown = ability.effects

  if (!Array.isArray(rawEffects)) {
    throw new InvalidCombatProfileError(`Los efectos de ${field} deben ser una lista.`)
  }

  const effects = rawEffects as readonly CombatAbilityEffect[]

  return Object.freeze({
    abilityId: ability.abilityId,
    name: ability.name,
    powerCost: Object.freeze({ ...cost }),
    chargeTurns: ability.chargeTurns,
    effects: Object.freeze(
      effects.map((effect, position) =>
        validateAbilityEffect(effect, `${field}.effects[${String(position)}]`),
      ),
    ),
  })
}

const freezeAbilities = (abilities: readonly CombatAbility[]): readonly CombatAbility[] => {
  if (!Array.isArray(abilities)) {
    throw new InvalidCombatProfileError('Las habilidades del perfil deben ser una lista.')
  }

  const frozen = abilities.map(validateAbility)
  const ids = new Set(frozen.map((ability) => ability.abilityId))

  if (ids.size !== frozen.length) {
    throw new InvalidCombatProfileError('El perfil declara dos habilidades con el mismo abilityId.')
  }

  return Object.freeze(frozen)
}

const requireOpaqueRecord = (value: unknown, field: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidCombatProfileError(`"${field}" debe ser un objeto.`)
  }

  return value as Readonly<Record<string, unknown>>
}

const requireNullableOpaqueRecord = (
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> | null =>
  value === null ? null : requireOpaqueRecord(value, field)

/**
 * Valida y congela la epica equipada (HU-31). `baseEffect`/`specificEffect`/
 * `applied.*` son objetos OPACOS: solo se comprueba su forma minima (objeto,
 * o `null` donde el contrato lo permite), nunca su contenido -- interpretarlo
 * es responsabilidad de una Task/HU futura, no de este congelamiento.
 */
const validateEpic = (epic: CombatEpic): CombatEpic => {
  requireNonEmptyText(epic.epicProductId, 'epic.epicProductId')
  requireNonEmptyText(epic.epicReference, 'epic.epicReference')
  requireNonEmptyText(epic.name, 'epic.name')
  requireNonEmptyText(epic.compatibleHeroSubtype, 'epic.compatibleHeroSubtype')

  const baseEffect = requireNullableOpaqueRecord(epic.baseEffect, 'epic.baseEffect')
  const specificEffect = requireOpaqueRecord(epic.specificEffect, 'epic.specificEffect')
  const applied = requireOpaqueRecord(epic.applied, 'epic.applied')
  const baseApplied = requireNullableOpaqueRecord(applied.baseApplied, 'epic.applied.baseApplied')
  const additionalApplied = requireNullableOpaqueRecord(
    applied.additionalApplied,
    'epic.applied.additionalApplied',
  )

  return Object.freeze({
    epicProductId: epic.epicProductId,
    epicReference: epic.epicReference,
    name: epic.name,
    compatibleHeroSubtype: epic.compatibleHeroSubtype,
    baseEffect: baseEffect === null ? null : Object.freeze({ ...baseEffect }),
    specificEffect: Object.freeze({ ...specificEffect }),
    applied: Object.freeze({
      baseApplied: baseApplied === null ? null : Object.freeze({ ...baseApplied }),
      additionalApplied:
        additionalApplied === null ? null : Object.freeze({ ...additionalApplied }),
    }),
  })
}

/**
 * Valida y congela un perfil. Los enteros son los que Player-Inventory garantiza
 * para las estadisticas efectivas; un valor distinto es un dato upstream mal
 * formado y NO se corrige en silencio (nada de `Math.floor` para que pase).
 */
export const createCombatProfile = (profile: CombatProfile): CombatProfile => {
  requireNonNegativeInteger(profile.maxHealth, 'maxHealth')
  requireNonNegativeInteger(profile.defense, 'defense')

  if (profile.attack !== null) {
    requireNonNegativeInteger(profile.attack, 'attack')
  }

  const { maxPower, abilities, level, epic, ...rest } = profile

  if (maxPower !== undefined) {
    requireNonNegativeInteger(maxPower, 'maxPower')
  }

  if (level !== undefined && (!Number.isInteger(level) || level < 1 || level > 8)) {
    throw new InvalidCombatProfileError(
      `El perfil de combate necesita "level" como entero entre 1 y 8. Se recibio ${String(level)}.`,
    )
  }

  return Object.freeze({
    ...rest,
    damage: profile.damage === null ? null : Object.freeze({ ...profile.damage }),
    activeEffects: Object.freeze(
      profile.activeEffects.map((effect) => Object.freeze({ ...effect })),
    ),
    ...(maxPower === undefined ? {} : { maxPower }),
    ...(level === undefined ? {} : { level }),
    ...(abilities === undefined ? {} : { abilities: freezeAbilities(abilities) }),
    ...(epic === undefined ? {} : { epic: validateEpic(epic) }),
  })
}
