import type {
  BotCatalogCandidates,
  BotCatalogEquipment,
  BotCatalogHero,
} from '../../src/application/ports/BotCombatCatalogPort'

export const offensiveHero = (overrides: Partial<BotCatalogHero> = {}): BotCatalogHero => ({
  productId: '10000000-0000-4000-8000-000000000001',
  sku: 'hero-offensive',
  heroSubtype: 'GUERRERO_ARMAS',
  basePower: 10,
  baseHealth: 40,
  baseDefense: 8,
  baseAttack: { mode: 'FIXED', amount: 7 },
  baseDamage: { mode: 'DICE', count: 1, sides: 6 },
  abilities: ['20000000-0000-4000-8000-000000000001'],
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
  abilities: ['20000000-0000-4000-8000-000000000002'],
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
    {
      productId: '20000000-0000-4000-8000-000000000001',
      sku: 'ability-strike',
      name: 'Golpe preciso',
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
    },
    {
      productId: '20000000-0000-4000-8000-000000000002',
      sku: 'ability-heal',
      name: 'Curacion',
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
    },
  ],
  equipment: [],
  epics: [],
  ...overrides,
})
