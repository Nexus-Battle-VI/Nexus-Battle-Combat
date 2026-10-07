import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import type {
  BotCatalogAbility,
  BotCatalogCandidates,
  BotCatalogEffect,
  BotCatalogEpic,
  BotCatalogEquipment,
  BotCatalogHero,
  BotCatalogMagnitude,
  BotCombatCatalogPort,
} from '../../../application/ports/BotCombatCatalogPort'
import { getInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'

const SERVICE = 'catalog'
const PATH = '/api/internal/v1/catalog/combat/bot-candidates'
type UnknownRecord = Readonly<Record<string, unknown>>

const invalid = (): UpstreamServiceError => new UpstreamServiceError(SERVICE, 'respuesta_invalida')

const record = (value: unknown): UnknownRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  return value as UnknownRecord
}

const text = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid()
  return value
}

const integer = (value: unknown, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) throw invalid()
  return value
}

const optionalInteger = (value: unknown, minimum = 0): number | undefined =>
  value === undefined ? undefined : integer(value, minimum)

const stringList = (value: unknown, minimum = 0): readonly string[] => {
  if (!Array.isArray(value) || value.length < minimum) throw invalid()
  return value.map(text)
}

const list = <T>(value: unknown, parse: (entry: unknown) => T): readonly T[] => {
  if (!Array.isArray(value)) throw invalid()
  return value.map(parse)
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid()
  return value as T
}

const magnitude = (value: unknown, allowPercentage = true): BotCatalogMagnitude => {
  const input = record(value)
  const mode = oneOf(
    input.mode,
    allowPercentage ? ['FIXED', 'PERCENTAGE', 'DICE'] : ['FIXED', 'DICE'],
  )

  if (mode === 'FIXED') return { mode, amount: integer(input.amount, 1) }
  if (mode === 'PERCENTAGE') {
    const basisPoints = integer(input.basisPoints, 1)
    if (basisPoints > 10_000) throw invalid()
    return { mode, basisPoints }
  }
  return { mode, count: integer(input.count, 1), sides: integer(input.sides, 2) }
}

const baseMagnitude = (value: unknown): NonNullable<BotCatalogHero['baseAttack']> => {
  const parsed = magnitude(value, false)
  if (parsed.mode === 'PERCENTAGE') throw invalid()
  return parsed
}

const effect = (value: unknown): BotCatalogEffect => {
  const input = record(value)
  const kind = oneOf(input.kind, [
    'STAT_MODIFIER',
    'DAMAGE',
    'HEALING',
    'IMMUNITY',
    'REFLECT_DAMAGE',
    'REVIVE',
    'TEMPORARY_STATUS',
  ] as const)
  const target = oneOf(input.target, [
    'SELF',
    'ALLY',
    'ALLIED_GROUP',
    'OPPONENT',
    'ENEMY_GROUP',
  ] as const)
  if (input.stackable !== false) throw invalid()

  const durationTurns = optionalInteger(input.durationTurns, 1)
  const activationCondition =
    input.activationCondition === undefined ? undefined : { ...record(input.activationCondition) }
  const base = {
    kind,
    target,
    ...(durationTurns === undefined ? {} : { durationTurns }),
    ...(activationCondition === undefined ? {} : { activationCondition }),
    stackable: false as const,
  }

  if (kind === 'STAT_MODIFIER') {
    return {
      ...base,
      statistic: text(input.statistic),
      operation: text(input.operation),
      magnitude: magnitude(input.magnitude),
    }
  }
  if (kind === 'DAMAGE' || kind === 'HEALING') {
    return { ...base, magnitude: magnitude(input.magnitude) }
  }
  if (kind === 'REFLECT_DAMAGE') {
    const parsed = magnitude(input.magnitude)
    if (parsed.mode !== 'PERCENTAGE') throw invalid()
    return { ...base, magnitude: parsed }
  }
  if (kind === 'REVIVE') {
    const parsed = magnitude(input.magnitude)
    if (parsed.mode === 'DICE') throw invalid()
    return { ...base, magnitude: parsed }
  }
  if (kind === 'IMMUNITY') return { ...base, immunityCode: text(input.immunityCode) }
  if (durationTurns === undefined) throw invalid()
  return { ...base, durationTurns, statusCode: text(input.statusCode) }
}

const hero = (value: unknown): BotCatalogHero => {
  const input = record(value)
  const abilities = stringList(input.abilities)
  if (abilities.length !== 3 || new Set(abilities).size !== 3) throw invalid()

  const base = {
    productId: text(input.productId),
    sku: text(input.sku),
    heroSubtype: text(input.heroSubtype),
    basePower: integer(input.basePower),
    baseHealth: integer(input.baseHealth),
    baseDefense: integer(input.baseDefense),
    abilities,
  }
  const baseAttack = input.baseAttack === undefined ? undefined : baseMagnitude(input.baseAttack)
  const baseDamage = input.baseDamage === undefined ? undefined : baseMagnitude(input.baseDamage)
  const baseHealing = input.baseHealing === undefined ? undefined : baseMagnitude(input.baseHealing)
  const offensive =
    baseAttack !== undefined && baseDamage !== undefined && baseHealing === undefined
  const support = baseAttack === undefined && baseDamage === undefined && baseHealing !== undefined

  if (!offensive && !support) throw invalid()
  return {
    ...base,
    ...(baseAttack === undefined ? {} : { baseAttack }),
    ...(baseDamage === undefined ? {} : { baseDamage }),
    ...(baseHealing === undefined ? {} : { baseHealing }),
  }
}

const ability = (value: unknown): BotCatalogAbility => {
  const input = record(value)
  const powerCostMode = oneOf(input.powerCostMode, ['FIXED', 'ALL_AVAILABLE'] as const)
  const powerCost = optionalInteger(input.powerCost, 1)
  if ((powerCostMode === 'FIXED') !== (powerCost !== undefined)) throw invalid()

  return {
    productId: text(input.productId),
    sku: text(input.sku),
    name: text(input.name),
    compatibleHeroSubtypes: stringList(input.compatibleHeroSubtypes, 1),
    powerCostMode,
    ...(powerCost === undefined ? {} : { powerCost }),
    chargeTurns: integer(input.chargeTurns, 1),
    effects: list(input.effects, effect),
  }
}

const equipment = (value: unknown): BotCatalogEquipment => {
  const input = record(value)
  const type = oneOf(input.type, ['ARMA', 'ARMADURA', 'ITEM'] as const)
  const compatibilityScope = oneOf(input.compatibilityScope, [
    'ALL_HEROES',
    'SELECTED_SUBTYPES',
  ] as const)
  const compatibleHeroSubtypes =
    input.compatibleHeroSubtypes === undefined
      ? undefined
      : stringList(input.compatibleHeroSubtypes, 1)

  if ((compatibilityScope === 'SELECTED_SUBTYPES') !== (compatibleHeroSubtypes !== undefined)) {
    throw invalid()
  }

  const slot =
    input.slot === undefined
      ? undefined
      : oneOf(input.slot, ['HEAD', 'CHEST', 'GLOVES', 'BRACERS', 'PANTS', 'SHOES'] as const)
  if ((type === 'ARMADURA') !== (slot !== undefined)) throw invalid()

  return {
    productId: text(input.productId),
    sku: text(input.sku),
    type,
    compatibilityScope,
    ...(compatibleHeroSubtypes === undefined ? {} : { compatibleHeroSubtypes }),
    effects: list(input.effects, effect),
    ...(slot === undefined ? {} : { slot }),
    ...(input.setCode === undefined ? {} : { setCode: text(input.setCode) }),
  }
}

const epic = (value: unknown): BotCatalogEpic => {
  const input = record(value)
  const specificEffects = list(input.specificEffects, effect)
  if (specificEffects.length === 0) throw invalid()
  const powerCost = integer(input.powerCost)
  const cooldownTurns = integer(input.cooldownTurns, 1)
  if (powerCost !== 0 || cooldownTurns !== 2) throw invalid()

  return {
    productId: text(input.productId),
    sku: text(input.sku),
    name: text(input.name),
    compatibleHeroSubtype: text(input.compatibleHeroSubtype),
    ...(input.generalEffect === undefined ? {} : { generalEffect: effect(input.generalEffect) }),
    specificEffects,
    powerCost,
    cooldownTurns,
  }
}

const parseCandidates = (body: unknown): BotCatalogCandidates => {
  const input = record(body)
  if (input.schemaVersion !== '1') throw invalid()

  return {
    schemaVersion: '1',
    heroes: list(input.heroes, hero),
    abilities: list(input.abilities, ability),
    equipment: list(input.equipment, equipment),
    epics: list(input.epics, epic),
  }
}

export class CatalogBotCandidatesHttpClient implements BotCombatCatalogPort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async listBotCandidates(): Promise<BotCatalogCandidates> {
    const result = await getInternalJson(SERVICE, PATH, this.options)
    if (!result.found) throw new UpstreamServiceError(SERVICE, 'error_servidor')
    return parseCandidates(result.body)
  }
}
