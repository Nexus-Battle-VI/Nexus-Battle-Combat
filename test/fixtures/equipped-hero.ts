import type {
  EquippedHero,
  EquippedHeroEffect,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'

/**
 * FIXTURE CONTRACTUAL del heroe equipado (HU-15, HU-25).
 *
 * Fija la forma JSON que Nexus-Battle-Player-Inventory entrega en
 * `GET /api/internal/v1/players/:playerId/equipped-hero` (su
 * `docs/equipped-hero-contract.md` y su `test/integration/equipped-hero-http.spec.ts`).
 * NO se comparte fisicamente entre repositorios (romperia la frontera): cada
 * uno fija la misma forma en sus propias pruebas. Si el contrato cambia, este
 * fichero cambia a mano, y `player-inventory-equipped-hero-contract.spec.ts`
 * falla hasta que el parser lo acepte.
 *
 * Los cuatro efectos cubren los casos que importan: uno YA aplicado a las
 * estadisticas, el `CRITICAL_CHANCE PERCENTAGE 300` de la espada de dos manos
 * (el caso de unidad ambigua), uno condicionado y uno dirigido al oponente con
 * dados.
 */
export const attackBonusEffect: EquippedHeroEffect = {
  sourceProductId: '6a3f3c2e-2b7e-4d1a-9f0a-1c9e8d7b6a55',
  sourceProductReference: 'espada-de-dos-manos',
  kind: 'STAT_MODIFIER',
  target: 'SELF',
  statistic: 'ATTACK',
  operation: 'INCREASE',
  magnitude: { mode: 'FIXED', amount: 3 },
  hasActivationCondition: false,
  appliedToStats: true,
}

export const criticalChancePercentageEffect: EquippedHeroEffect = {
  sourceProductId: '6a3f3c2e-2b7e-4d1a-9f0a-1c9e8d7b6a55',
  sourceProductReference: 'espada-de-dos-manos',
  kind: 'STAT_MODIFIER',
  target: 'SELF',
  statistic: 'CRITICAL_CHANCE',
  operation: 'INCREASE',
  magnitude: { mode: 'PERCENTAGE', basisPoints: 300 },
  hasActivationCondition: false,
  appliedToStats: false,
}

export const conditionalDefenseEffect: EquippedHeroEffect = {
  sourceProductId: '2b1c9e7d-4a3f-4c8e-8d21-7f6a5b4c3d22',
  sourceProductReference: 'amuleto-de-hierro',
  kind: 'STAT_MODIFIER',
  target: 'SELF',
  statistic: 'DEFENSE',
  operation: 'INCREASE',
  magnitude: { mode: 'FIXED', amount: 2 },
  hasActivationCondition: true,
  appliedToStats: false,
}

export const opponentDamageDiceEffect: EquippedHeroEffect = {
  sourceProductId: '9d8c7b6a-5e4f-4a3b-9c2d-1e0f9a8b7c66',
  sourceProductReference: 'daga-envenenada',
  kind: 'DAMAGE',
  target: 'OPPONENT',
  magnitude: { mode: 'DICE', count: 1, sides: 6 },
  hasActivationCondition: false,
  appliedToStats: false,
}

const baseStats = {
  power: 8,
  health: 40,
  defense: 8,
  attack: 10,
  damage: { mode: 'DICE', count: 1, sides: 4 },
  healing: null,
} as const

const effectiveStats = { ...baseStats, attack: 13 } as const

/** Cuerpo JSON del contrato, tal como lo entrega Player-Inventory (incluye `name`). */
export const equippedHeroContractBody = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  playerId: 'jugador-1',
  heroId: '0f0a0d0e-6c1b-4d63-8a53-2c1d5b7e9a10',
  reference: 'guerrero-armas',
  subtype: 'GUERRERO_ARMAS',
  name: 'Guerrero Armas',
  baseStats: { ...baseStats },
  effectiveStats: { ...effectiveStats },
  activeEffects: [
    attackBonusEffect,
    criticalChancePercentageEffect,
    conditionalDefenseEffect,
    opponentDamageDiceEffect,
  ],
  ready: true,
  selectedAt: '2026-09-19T12:00:00.000Z',
  ...overrides,
})

/** El `EquippedHero` que el parser produce a partir de `equippedHeroContractBody()`. */
export const equippedHeroFixture = (overrides: Partial<EquippedHero> = {}): EquippedHero => ({
  playerId: 'jugador-1',
  heroId: '0f0a0d0e-6c1b-4d63-8a53-2c1d5b7e9a10',
  reference: 'guerrero-armas',
  subtype: 'GUERRERO_ARMAS',
  baseStats,
  effectiveStats,
  maxPower: effectiveStats.power,
  activeEffects: [
    attackBonusEffect,
    criticalChancePercentageEffect,
    conditionalDefenseEffect,
    opponentDamageDiceEffect,
  ],
  ready: true,
  selectedAt: '2026-09-19T12:00:00.000Z',
  ...overrides,
})
