import {
  createCombatProfile,
  type CombatAbilityEffect,
  type CombatProfile,
} from '../../domain/entities/CombatProfile'
import type { BoundedRandom } from '../../domain/policies/TurnOrderPolicy'
import { UpstreamServiceError } from '../errors/UpstreamErrors'
import type {
  BotCatalogAbility,
  BotCatalogCandidates,
  BotCatalogEffect,
  BotCatalogEquipment,
  BotCatalogEpic,
  BotCatalogHero,
  BotCatalogMagnitude,
  BotCombatCatalogPort,
} from '../ports/BotCombatCatalogPort'

const SUPPORT_SUBTYPES: ReadonlySet<string> = new Set(['CHAMAN', 'MEDICO'])
const ARMOR_SLOTS = ['HEAD', 'CHEST', 'GLOVES', 'BRACERS', 'PANTS', 'SHOES'] as const
const SLOT_FOR_ARMOR: Readonly<Record<(typeof ARMOR_SLOTS)[number], BotLoadoutSlot>> = {
  HEAD: 'HELMET',
  CHEST: 'CHEST',
  GLOVES: 'GLOVES',
  BRACERS: 'BRACERS',
  PANTS: 'PANTS',
  SHOES: 'SHOES',
}
const EPIC_ROLL_BOUND = 10_000
const EPIC_ROLL_SUCCESS_COUNT = 500

export type BotLoadoutSlot =
  | 'WEAPON_1'
  | 'WEAPON_2'
  | 'HELMET'
  | 'CHEST'
  | 'GLOVES'
  | 'BRACERS'
  | 'PANTS'
  | 'SHOES'
  | 'ITEM_1'
  | 'ITEM_2'

export interface BotLoadoutEntry {
  readonly slot: BotLoadoutSlot
  readonly productId: string
  readonly sku: string
}

export interface PreparedBotParticipant {
  readonly heroId: string
  readonly heroSubtype: string
  readonly profile: CombatProfile
  /** Trazabilidad de la configuración efímera; no se persiste como inventario. */
  readonly loadout: readonly BotLoadoutEntry[]
}

interface SelectedEquipment {
  readonly slot: BotLoadoutSlot
  readonly product: BotCatalogEquipment
}

interface StatAccumulator {
  additive: number
  percentOfBase: number
  multipliers: number[]
  setValue: number | null
}

const invalidCatalog = (): UpstreamServiceError =>
  new UpstreamServiceError('catalog', 'respuesta_invalida')

const byProductId = <T extends { readonly productId: string }>(left: T, right: T): number =>
  left.productId.localeCompare(right.productId)

const compatibleWith = (product: BotCatalogEquipment, subtype: string): boolean =>
  product.compatibilityScope === 'ALL_HEROES' ||
  product.compatibleHeroSubtypes?.includes(subtype) === true

const isDirectDamage = (effect: BotCatalogEffect): boolean =>
  effect.kind === 'DAMAGE' ||
  effect.kind === 'REFLECT_DAMAGE' ||
  (effect.kind === 'STAT_MODIFIER' && effect.statistic === 'DAMAGE')

const abilityEffect = (effect: BotCatalogEffect): CombatAbilityEffect => ({
  kind: effect.kind,
  target: effect.target,
  ...(effect.statistic === undefined ? {} : { statistic: effect.statistic }),
  ...(effect.operation === undefined ? {} : { operation: effect.operation }),
  ...(effect.magnitude === undefined ? {} : { magnitude: { ...effect.magnitude } }),
  ...(effect.durationTurns === undefined ? {} : { durationTurns: effect.durationTurns }),
  ...(effect.immunityCode === undefined ? {} : { immunityCode: effect.immunityCode }),
  hasActivationCondition: effect.activationCondition !== undefined,
})

const assertDatasetConsistency = (candidates: BotCatalogCandidates): void => {
  if (candidates.heroes.length === 0) {
    throw invalidCatalog()
  }

  const abilities = new Map(candidates.abilities.map((ability) => [ability.productId, ability]))

  for (const hero of candidates.heroes) {
    const support = SUPPORT_SUBTYPES.has(hero.heroSubtype)

    if (support && (hero.baseAttack !== undefined || hero.baseDamage !== undefined)) {
      throw invalidCatalog()
    }

    for (const abilityId of hero.abilities) {
      const ability = abilities.get(abilityId)

      if (ability?.compatibleHeroSubtypes.includes(hero.heroSubtype) !== true) {
        throw invalidCatalog()
      }

      if (ability.powerCostMode === 'FIXED' && ability.powerCost === undefined) {
        throw invalidCatalog()
      }

      if (support && ability.effects.some(isDirectDamage)) {
        throw invalidCatalog()
      }
    }

    if (
      support &&
      candidates.epics
        .filter((epic) => epic.compatibleHeroSubtype === hero.heroSubtype)
        .some((epic) =>
          [
            ...(epic.generalEffect === undefined ? [] : [epic.generalEffect]),
            ...epic.specificEffects,
          ].some(isDirectDamage),
        )
    ) {
      throw invalidCatalog()
    }
  }
}

const choose = <T>(items: readonly T[], random: BoundedRandom): T => {
  const item = items[random.nextInt(items.length)]

  if (item === undefined) throw invalidCatalog()
  return item
}

const selectWithoutReplacement = (
  candidates: readonly BotCatalogEquipment[],
  slots: readonly BotLoadoutSlot[],
  random: BoundedRandom,
): SelectedEquipment[] => {
  const available = [...candidates].sort(byProductId)
  const selected: SelectedEquipment[] = []

  for (const slot of slots) {
    if (available.length === 0) break
    const index = random.nextInt(available.length)
    const [product] = available.splice(index, 1)

    if (product !== undefined) selected.push({ slot, product })
  }

  return selected
}

const selectLoadout = (
  candidates: BotCatalogCandidates,
  hero: BotCatalogHero,
  random: BoundedRandom,
): readonly SelectedEquipment[] => {
  const compatible = candidates.equipment.filter(
    (product) =>
      compatibleWith(product, hero.heroSubtype) &&
      (!SUPPORT_SUBTYPES.has(hero.heroSubtype) || !product.effects.some(isDirectDamage)),
  )
  const weapons = compatible.filter((product) => product.type === 'ARMA')
  const items = compatible.filter((product) => product.type === 'ITEM')
  const selected: SelectedEquipment[] = [
    ...selectWithoutReplacement(weapons, ['WEAPON_1', 'WEAPON_2'], random),
  ]

  for (const armorSlot of ARMOR_SLOTS) {
    const armor = compatible
      .filter((product) => product.type === 'ARMADURA' && product.slot === armorSlot)
      .sort(byProductId)

    if (armor.length > 0) {
      selected.push({ slot: SLOT_FOR_ARMOR[armorSlot], product: choose(armor, random) })
    }
  }

  selected.push(...selectWithoutReplacement(items, ['ITEM_1', 'ITEM_2'], random))

  return selected
}

const emptyAccumulator = (): StatAccumulator => ({
  additive: 0,
  percentOfBase: 0,
  multipliers: [],
  setValue: null,
})

type ApplicableStatEffect = BotCatalogEffect & {
  readonly statistic: string
  readonly operation: string
  readonly magnitude: BotCatalogMagnitude
}

const applicableStat = (effect: BotCatalogEffect): effect is ApplicableStatEffect =>
  effect.kind === 'STAT_MODIFIER' &&
  effect.target === 'SELF' &&
  effect.durationTurns === undefined &&
  effect.activationCondition === undefined &&
  effect.statistic !== undefined &&
  ['POWER', 'HEALTH', 'DEFENSE', 'ATTACK'].includes(effect.statistic) &&
  effect.operation !== undefined &&
  effect.magnitude !== undefined

const effectiveStats = (
  hero: BotCatalogHero,
  loadout: readonly SelectedEquipment[],
): {
  readonly power: number
  readonly health: number
  readonly defense: number
  readonly attack: number | null
  readonly activeEffects: CombatProfile['activeEffects']
} => {
  const base: Readonly<Record<string, number>> = {
    POWER: hero.basePower,
    HEALTH: hero.baseHealth,
    DEFENSE: hero.baseDefense,
    ATTACK: hero.baseAttack?.mode === 'FIXED' ? hero.baseAttack.amount : 0,
  }
  const accumulators = new Map<string, StatAccumulator>()
  const activeEffects: CombatProfile['activeEffects'][number][] = []

  for (const { product } of loadout) {
    for (const effect of product.effects) {
      const applied = applicableStat(effect)

      if (applied) {
        const { statistic, operation, magnitude } = effect
        const accumulator = accumulators.get(statistic) ?? emptyAccumulator()
        const baseValue = base[statistic] ?? 0

        if (operation === 'SET' && magnitude.mode === 'FIXED') {
          accumulator.setValue = magnitude.amount
        } else if (operation === 'MULTIPLY') {
          if (magnitude.mode === 'FIXED') accumulator.multipliers.push(magnitude.amount)
          if (magnitude.mode === 'PERCENTAGE') {
            accumulator.multipliers.push(1 + magnitude.basisPoints / 10_000)
          }
        } else if (operation === 'INCREASE' || operation === 'DECREASE') {
          const sign = operation === 'DECREASE' ? -1 : 1
          if (magnitude.mode === 'FIXED') accumulator.additive += sign * magnitude.amount
          if (magnitude.mode === 'PERCENTAGE') {
            accumulator.percentOfBase += sign * (magnitude.basisPoints / 10_000) * baseValue
          }
        }

        accumulators.set(statistic, accumulator)
      }

      activeEffects.push({
        sourceProductId: product.productId,
        sourceProductReference: product.sku,
        kind: effect.kind,
        target: effect.target,
        ...(effect.statistic === undefined ? {} : { statistic: effect.statistic }),
        ...(effect.operation === undefined ? {} : { operation: effect.operation }),
        ...(effect.magnitude === undefined ? {} : { magnitude: { ...effect.magnitude } }),
        ...(effect.durationTurns === undefined ? {} : { durationTurns: effect.durationTurns }),
        hasActivationCondition: effect.activationCondition !== undefined,
        appliedToStats: applied,
      })
    }
  }

  const resolve = (statistic: string): number => {
    const baseValue = base[statistic] ?? 0
    const accumulator = accumulators.get(statistic)
    if (accumulator === undefined) return baseValue
    if (accumulator.setValue !== null) return Math.max(0, Math.round(accumulator.setValue))

    let value = baseValue + accumulator.additive + accumulator.percentOfBase
    for (const multiplier of accumulator.multipliers) value *= multiplier
    return Math.max(0, Math.round(value))
  }

  return {
    power: resolve('POWER'),
    health: resolve('HEALTH'),
    defense: resolve('DEFENSE'),
    attack: hero.baseAttack?.mode === 'FIXED' ? resolve('ATTACK') : null,
    activeEffects,
  }
}

const combatAbility = (ability: BotCatalogAbility) => {
  let powerCost:
    { readonly mode: 'ALL_AVAILABLE' } | { readonly mode: 'FIXED'; readonly amount: number }

  if (ability.powerCostMode === 'ALL_AVAILABLE') {
    powerCost = { mode: 'ALL_AVAILABLE' }
  } else {
    const amount = ability.powerCost
    if (amount === undefined) throw invalidCatalog()
    powerCost = { mode: 'FIXED', amount }
  }

  return {
    abilityId: ability.productId,
    name: ability.name,
    powerCost,
    chargeTurns: ability.chargeTurns,
    effects: ability.effects.map(abilityEffect),
  }
}

const combatEpic = (epic: BotCatalogEpic) => {
  const baseEffect = epic.generalEffect === undefined ? null : { ...epic.generalEffect }
  const specificEffects = epic.specificEffects.map((effect) => ({ ...effect }))
  const additionalApplied = specificEffects.map((effect) => ({ ...effect }))

  return {
    epicProductId: epic.productId,
    epicReference: epic.sku,
    name: epic.name,
    compatibleHeroSubtype: epic.compatibleHeroSubtype,
    powerCost: epic.powerCost,
    cooldownTurns: epic.cooldownTurns,
    baseEffect,
    specificEffects,
    applied: { baseApplied: baseEffect, additionalApplied },
    executableEffects: [
      ...(epic.generalEffect === undefined ? [] : [abilityEffect(epic.generalEffect)]),
      ...epic.specificEffects.map(abilityEffect),
    ],
  }
}

/** Construye un snapshot efímero de IA sin usuario, inventario ni ownership ficticio. */
export class BotParticipantFactory {
  constructor(
    private readonly catalog: BotCombatCatalogPort,
    private readonly random: BoundedRandom,
  ) {}

  async create(): Promise<PreparedBotParticipant> {
    const candidates = await this.catalog.listBotCandidates()

    assertDatasetConsistency(candidates)

    const heroes = [...candidates.heroes].sort(byProductId)
    const hero = choose(heroes, this.random)
    const loadout = selectLoadout(candidates, hero, this.random)
    const stats = effectiveStats(hero, loadout)
    const abilitiesById = new Map(
      candidates.abilities.map((ability) => [ability.productId, ability]),
    )
    const abilities = hero.abilities.map((abilityId) => {
      const ability = abilitiesById.get(abilityId)
      if (ability === undefined) throw invalidCatalog()
      return combatAbility(ability)
    })
    const compatibleEpics = candidates.epics
      .filter((epic) => epic.compatibleHeroSubtype === hero.heroSubtype)
      .sort(byProductId)
    const receivesEpic = this.random.nextInt(EPIC_ROLL_BOUND) < EPIC_ROLL_SUCCESS_COUNT
    const epic =
      receivesEpic && compatibleEpics.length > 0
        ? combatEpic(choose(compatibleEpics, this.random))
        : undefined
    const profile = createCombatProfile({
      heroId: hero.productId,
      subtype: hero.heroSubtype,
      maxHealth: stats.health,
      attack: stats.attack,
      defense: stats.defense,
      damage: hero.baseDamage === undefined ? null : { ...hero.baseDamage },
      activeEffects: stats.activeEffects,
      maxPower: stats.power,
      abilities,
      ...(epic === undefined ? {} : { epic }),
    })

    return {
      heroId: hero.productId,
      heroSubtype: hero.heroSubtype,
      profile,
      loadout: loadout.map(({ slot, product }) => ({
        slot,
        productId: product.productId,
        sku: product.sku,
      })),
    }
  }
}
