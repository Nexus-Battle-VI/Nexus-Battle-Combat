export type BotCatalogMagnitude =
  | { readonly mode: 'FIXED'; readonly amount: number }
  | { readonly mode: 'PERCENTAGE'; readonly basisPoints: number }
  | { readonly mode: 'DICE'; readonly count: number; readonly sides: number }

export interface BotCatalogEffect {
  readonly kind:
    | 'STAT_MODIFIER'
    | 'DAMAGE'
    | 'HEALING'
    | 'IMMUNITY'
    | 'REFLECT_DAMAGE'
    | 'REVIVE'
    | 'TEMPORARY_STATUS'
  readonly target: 'SELF' | 'ALLY' | 'ALLIED_GROUP' | 'OPPONENT' | 'ENEMY_GROUP'
  readonly statistic?: string
  readonly operation?: string
  readonly magnitude?: BotCatalogMagnitude
  readonly durationTurns?: number
  readonly activationCondition?: Readonly<Record<string, unknown>>
  readonly immunityCode?: string
  readonly statusCode?: string
  readonly stackable: false
}

export interface BotCatalogHero {
  readonly productId: string
  readonly sku: string
  readonly heroSubtype: string
  readonly basePower: number
  readonly baseHealth: number
  readonly baseDefense: number
  readonly baseAttack?: Exclude<BotCatalogMagnitude, { readonly mode: 'PERCENTAGE' }>
  readonly baseDamage?: Exclude<BotCatalogMagnitude, { readonly mode: 'PERCENTAGE' }>
  readonly baseHealing?: Exclude<BotCatalogMagnitude, { readonly mode: 'PERCENTAGE' }>
  readonly abilities: readonly string[]
}

export interface BotCatalogAbility {
  readonly productId: string
  readonly sku: string
  readonly name: string
  readonly compatibleHeroSubtypes: readonly string[]
  readonly powerCostMode: 'FIXED' | 'ALL_AVAILABLE'
  readonly powerCost?: number
  readonly chargeTurns: number
  readonly effects: readonly BotCatalogEffect[]
}

export interface BotCatalogEquipment {
  readonly productId: string
  readonly sku: string
  readonly type: 'ARMA' | 'ARMADURA' | 'ITEM'
  readonly compatibilityScope: 'ALL_HEROES' | 'SELECTED_SUBTYPES'
  readonly compatibleHeroSubtypes?: readonly string[]
  readonly effects: readonly BotCatalogEffect[]
  readonly slot?: 'HEAD' | 'CHEST' | 'GLOVES' | 'BRACERS' | 'PANTS' | 'SHOES'
  readonly setCode?: string
}

export interface BotCatalogEpic {
  readonly productId: string
  readonly sku: string
  readonly name: string
  readonly compatibleHeroSubtype: string
  readonly generalEffect?: BotCatalogEffect
  readonly specificEffects: readonly BotCatalogEffect[]
  readonly powerCost: number
  readonly cooldownTurns: number
}

export interface BotCatalogCandidates {
  readonly schemaVersion: '1'
  readonly heroes: readonly BotCatalogHero[]
  readonly abilities: readonly BotCatalogAbility[]
  readonly equipment: readonly BotCatalogEquipment[]
  readonly epics: readonly BotCatalogEpic[]
}

/** Frontera interna de gameplay; no representa vitrina, stock ni ownership. */
export interface BotCombatCatalogPort {
  listBotCandidates(): Promise<BotCatalogCandidates>
}

export const BOT_COMBAT_CATALOG = Symbol('BotCombatCatalogPort')
