import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { HmacMissionSeedFactory } from '../../src/adapters/outbound/system/HmacMissionSeedFactory'
import {
  simulateMission,
  type MissionSimulationRequest,
} from '../../src/application/services/MissionSimulation'

const fighter = (
  maxHealth: number,
  attack: number,
  defense: number,
  damage: number,
  ai: 'AGGRESSIVE' | 'GUARDED' | 'BOSS' = 'AGGRESSIVE',
) => ({ maxHealth, attack, defense, damage: { mode: 'FIXED' as const, amount: damage }, ai })

const temple: MissionSimulationRequest = {
  schemaVersion: 1,
  operationId: 'mission:temple-baseline:simulate',
  enrollmentId: 'temple-baseline',
  missionId: 'msn_templo_olvidado',
  difficulty: 'NORMAL',
  enemyStatMultiplier: 1,
  timeBudget: 'PT12H',
  hero: {
    heroId: 'hero-1',
    profile: {
      subtype: 'GUERRERO_TANQUE',
      effectiveStats: {
        health: 40,
        power: 5,
        attack: 10,
        defense: 8,
        damage: { mode: 'DICE', count: 1, sides: 4 },
      },
      abilities: [],
    },
  },
  strategy: { version: null, rotations: [], fallback: 'BASIC_ATTACK' },
  encounters: [
    {
      index: 1,
      kind: 'REGULAR',
      powerStep: 0,
      enemies: [{ enemyRef: 'sombra', name: 'Sombra', count: 4, profile: fighter(5, 2, 3, 1) }],
    },
    {
      index: 2,
      kind: 'REGULAR',
      powerStep: 0.05,
      enemies: [{ enemyRef: 'sombra', name: 'Sombra', count: 6, profile: fighter(5, 2, 3, 1) }],
    },
    {
      index: 3,
      kind: 'REGULAR',
      powerStep: 0.1,
      enemies: [
        { enemyRef: 'piedra', name: 'Piedra', count: 5, profile: fighter(8, 3, 6, 1, 'GUARDED') },
      ],
    },
    {
      index: 4,
      kind: 'REGULAR',
      powerStep: 0.15,
      enemies: [{ enemyRef: 'espectro', name: 'Espectro', count: 3, profile: fighter(7, 4, 4, 2) }],
    },
    {
      index: 5,
      kind: 'BOSS',
      powerStep: 0.2,
      enemies: [
        {
          enemyRef: 'guardian',
          name: 'Guardián',
          count: 1,
          profile: {
            ...fighter(100, 2, 5, 1, 'BOSS'),
            enrageBelowPercent: 50,
            enrageAttackBonus: 3,
          },
        },
      ],
    },
  ],
  rules: {
    turnDurationSeconds: 60,
    maxTurnsPerEncounter: 90,
    recoveryPercent: 35,
    criticalChance: 0.1,
    criticalMultiplier: 1.5,
  },
  bossDrops: [{ label: 'Trofeo', probability: 1, rolls: 1, productId: null }],
  master: null,
}

describe('mission simulation balance', () => {
  const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())

  it('lets a baseline equipped hero clear five chambers and defeat the boss', () => {
    const seed = new HmacMissionSeedFactory('test-secret').forOperation(temple.operationId)
    const result = simulateMission(temple, seed, factory)
    expect(result.combatOutcome).toBe('HERO_VICTORIOUS')
    expect(result.summary).toMatchObject({
      encountersCompleted: 5,
      bossDefeated: true,
      loot: [{ label: 'Trofeo', quantity: 1 }],
    })
    expect(
      result.combatLog.some(
        (event) => event.type === 'enemyDefeated' && event.enemyRef === 'guardian',
      ),
    ).toBe(true)
    expect(simulateMission(temple, seed, factory)).toEqual(result)
  })
})
