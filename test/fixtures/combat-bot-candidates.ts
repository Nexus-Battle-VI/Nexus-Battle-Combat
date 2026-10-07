import type {
  BotCatalogAbility,
  BotCatalogCandidates,
  BotCatalogEquipment,
  BotCatalogHero,
} from '../../src/application/ports/BotCombatCatalogPort'

const offensiveAbility = (sequence: number): BotCatalogAbility => ({
  productId: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  sku: `ability-strike-${String(sequence)}`,
  name: `Golpe preciso ${String(sequence)}`,
  compatibleHeroSubtypes: ['GUERRERO_ARMAS'],
  powerCostMode: 'FIXED',
  powerCost: 2,
  chargeTurns: 1,
  effects: [
    {
      kind: 'DAMAGE',
      target: 'OPPONENT',
      magnitude: { mode: 'FIXED', amount: 5 },
      stackable: false,
    },
  ],
})

const supportAbility = (sequence: number): BotCatalogAbility => ({
  productId: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  sku: `ability-heal-${String(sequence)}`,
  name: `Curacion ${String(sequence)}`,
  compatibleHeroSubtypes: ['CHAMAN', 'MEDICO'],
  powerCostMode: 'ALL_AVAILABLE',
  chargeTurns: 1,
  effects: [
    {
      kind: 'HEALING',
      target: 'ALLY',
      magnitude: { mode: 'FIXED', amount: 6 },
      stackable: false,
    },
  ],
})

export const offensiveHero = (overrides: Partial<BotCatalogHero> = {}): BotCatalogHero => ({
  productId: '10000000-0000-4000-8000-000000000001',
  sku: 'hero-offensive',
  heroSubtype: 'GUERRERO_ARMAS',
  basePower: 10,
  baseHealth: 40,
  baseDefense: 8,
  baseAttack: { mode: 'FIXED', amount: 7 },
  baseDamage: { mode: 'DICE', count: 1, sides: 6 },
  abilities: [
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
  ],
  ...overrides,
})

export const supportHero = (
  subtype: 'CHAMAN' | 'MEDICO',
  overrides: Partial<BotCatalogHero> = {},
): BotCatalogHero => ({
  productId: `10000000-0000-4000-8000-00000000000${subtype === 'CHAMAN' ? '2' : '3'}`,
  sku: `hero-${subtype.toLowerCase()}`,
  heroSubtype: subtype,
  basePower: 12,
  baseHealth: 36,
  baseDefense: 6,
  baseHealing: { mode: 'FIXED', amount: 8 },
  abilities: [
    '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000006',
  ],
  ...overrides,
})

export const equipment = (
  sequence: number,
  overrides: Partial<BotCatalogEquipment> = {},
): BotCatalogEquipment => ({
  productId: `30000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  sku: `equipment-${String(sequence)}`,
  type: 'ARMA',
  compatibilityScope: 'ALL_HEROES',
  effects: [],
  ...overrides,
})

export const botCatalogCandidates = (
  overrides: Partial<BotCatalogCandidates> = {},
): BotCatalogCandidates => ({
  schemaVersion: '1',
  heroes: [offensiveHero()],
  abilities: [
    offensiveAbility(1),
    offensiveAbility(3),
    offensiveAbility(4),
    supportAbility(2),
    supportAbility(5),
    supportAbility(6),
  ],
  equipment: [],
  epics: [],
  ...overrides,
})
