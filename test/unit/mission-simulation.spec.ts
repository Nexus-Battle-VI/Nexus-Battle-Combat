import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { HmacMissionSeedFactory } from '../../src/adapters/outbound/system/HmacMissionSeedFactory'
import {
  simulateMission,
  type MissionSimulationRequest,
} from '../../src/application/services/MissionSimulation'
import type { CombatAbility } from '../../src/domain/entities/CombatProfile'
import { RuleBasedPolicy } from '../../src/application/policies/RuleBasedPolicy'
import type { AiDecisionPort } from '../../src/application/ports/AiDecisionPort'

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

  it('lets a baseline equipped hero clear five chambers and defeat the boss', async () => {
    const seed = new HmacMissionSeedFactory('test-secret').forOperation(temple.operationId)
    const result = await simulateMission(temple, seed, factory, new RuleBasedPolicy())
    expect(result.combatOutcome).toBe('HERO_VICTORIOUS')
    expect(result.summary).toMatchObject({
      encountersCompleted: 5,
      bossDefeated: true,
      loot: [{ label: 'Trofeo', quantity: 1 }],
    })
    expect(result.combatLog).toContainEqual(
      expect.objectContaining({ type: 'combatantDefeated', encounter: 5, combatant: 'guardian#1' }),
    )
    expect(await simulateMission(temple, seed, factory, new RuleBasedPolicy())).toEqual(result)
  })
})

describe('mission simulation combat log (HU-72, HU-09)', () => {
  const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())

  it('records every defeat as combatantDefeated with its encounter and numbered instance', async () => {
    const seed = new HmacMissionSeedFactory('test-secret').forOperation(temple.operationId)
    const result = await simulateMission(temple, seed, factory, new RuleBasedPolicy())
    const defeats = result.combatLog.filter((event) => event.type === 'combatantDefeated')
    const summary = result.summary as { enemiesDefeated: { enemyRef: string; count: number }[] }
    const total = summary.enemiesDefeated.reduce((sum, entry) => sum + entry.count, 0)

    expect(defeats).toHaveLength(total)
    expect(result.combatLog.some((event) => event.type === 'enemyDefeated')).toBe(false)
    expect(
      defeats.filter((event) => event.encounter === 2).map((event) => event.combatant),
    ).toEqual(['sombra#1', 'sombra#2', 'sombra#3', 'sombra#4', 'sombra#5', 'sombra#6'])
    const keys = defeats.map((event) => `${String(event.encounter)}/${String(event.combatant)}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const event of defeats) {
      expect(event.combatant).toMatch(/^[a-z-]+#[1-9]\d*$/u)
      expect(Number.isInteger(event.turn)).toBe(true)
    }
  })
})

/** A skill Combat can execute: a self damage bonus without duration. */
const damageSkill = (abilityId: string, cost: number, chargeTurns = 0): CombatAbility => ({
  abilityId,
  name: abilityId,
  powerCost: { mode: 'FIXED', amount: cost },
  chargeTurns,
  effects: [
    {
      kind: 'STAT_MODIFIER',
      target: 'SELF',
      statistic: 'DAMAGE',
      operation: 'INCREASE',
      magnitude: { mode: 'FIXED', amount: 1 },
      hasActivationCondition: false,
    },
  ],
})

type Step =
  { readonly kind: 'BASIC_ATTACK' } | { readonly kind: 'ABILITY'; readonly abilityId: string }
const skill = (abilityId: string): Step => ({ kind: 'ABILITY', abilityId })
const basic: Step = { kind: 'BASIC_ATTACK' }

/** One long duel against a target that cannot fall: only the hero's decisions matter. */
const duel = (
  abilities: readonly CombatAbility[],
  rotations: readonly {
    readonly priority: 'HIGH' | 'MEDIUM' | 'LOW'
    readonly steps: readonly Step[]
  }[],
): MissionSimulationRequest => ({
  ...temple,
  operationId: `mission:duel:${rotations.map((r) => r.steps.length).join('-')}:${abilities.map((a) => a.abilityId).join('-')}`,
  hero: {
    heroId: 'hero-1',
    profile: {
      subtype: 'GUERRERO_ARMAS',
      effectiveStats: {
        health: 1000,
        power: 5,
        attack: 10,
        defense: 8,
        damage: { mode: 'FIXED', amount: 1 },
      },
      abilities,
    },
  },
  strategy: { version: 1, rotations, fallback: 'BASIC_ATTACK' },
  encounters: [
    {
      index: 1,
      kind: 'REGULAR',
      powerStep: 0,
      enemies: [
        { enemyRef: 'muneco', name: 'Muñeco', count: 1, profile: fighter(100000, 0, 0, 0) },
      ],
    },
  ],
  rules: {
    turnDurationSeconds: 60,
    maxTurnsPerEncounter: 6,
    recoveryPercent: 35,
    criticalChance: 0.1,
    criticalMultiplier: 1.5,
  },
  bossDrops: [],
})

const heroActions = async (request: MissionSimulationRequest) => {
  const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
  const seed = new HmacMissionSeedFactory('test-secret').forOperation(request.operationId)
  return (await simulateMission(request, seed, factory, new RuleBasedPolicy())).combatLog.filter(
    (event) => event.type === 'heroAction',
  )
}

describe('hero level multiplies the final damage result (HU-08 CA-06, option A)', () => {
  const basicOnly = [{ priority: 'HIGH' as const, steps: [basic] }]
  const withLevel = (level: number | undefined): MissionSimulationRequest => {
    const request = duel([], basicOnly)

    return level === undefined
      ? request
      : { ...request, hero: { ...request.hero, profile: { ...request.hero.profile, level } } }
  }
  const firstDamage = async (request: MissionSimulationRequest): Promise<number> =>
    Number((await heroActions(request)).find((action) => Number(action.damage) > 0)?.damage)

  it('level 3 deals at least 3x the damage of the same seeded hit at level 1 (fixed damage 1)', async () => {
    const base = await firstDamage(withLevel(undefined))

    expect(await firstDamage(withLevel(1))).toBe(base)
    expect(await firstDamage(withLevel(3))).toBeGreaterThanOrEqual(base * 3)
  })

  it('is deterministic: the same request and level give the same damage', async () => {
    expect(await firstDamage(withLevel(5))).toBe(await firstDamage(withLevel(5)))
  })
})

describe('rotation priority (HU-71 CA-02, CA-03)', () => {
  it('offers only HIGH to any policy while HIGH is viable', async () => {
    const request = duel(
      [damageSkill('alta', 1), damageSkill('media', 1)],
      [
        { priority: 'HIGH', steps: [skill('alta')] },
        { priority: 'MEDIUM', steps: [skill('media')] },
      ],
    )
    const decide: jest.MockedFunction<AiDecisionPort['decide']> = jest.fn((_state, legalActions) =>
      Promise.resolve(legalActions[0]!),
    )
    const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
    const seed = new HmacMissionSeedFactory('test-secret').forOperation(request.operationId)

    await simulateMission(request, seed, factory, { decide })

    expect(decide).toHaveBeenCalled()
    for (const [, legalActions] of decide.mock.calls) {
      expect(legalActions).toHaveLength(1)
      expect(legalActions[0]).toMatchObject({ kind: 'ABILITY', abilityId: 'alta' })
    }
  })

  it('D-2: when the high rotation lacks Power, the medium one acts', async () => {
    const actions = await heroActions(
      duel(
        [damageSkill('costosa', 10), damageSkill('barata', 1)],
        [
          { priority: 'HIGH', steps: [skill('costosa')] },
          { priority: 'MEDIUM', steps: [skill('barata')] },
        ],
      ),
    )
    expect(actions[0]).toMatchObject({
      action: 'ABILITY',
      abilityId: 'barata',
      strategy: {
        rotation: 'MEDIUM',
        step: 1,
        fallback: false,
        skipped: [{ rotation: 'HIGH', step: 1, reason: 'NOT_ENOUGH_POWER' }],
      },
    })
  })

  it('D-3: with the high and medium rotations recharging, the low one acts', async () => {
    const actions = await heroActions(
      duel(
        [damageSkill('golpe', 1, 3), damageSkill('embate', 1, 3)],
        [
          { priority: 'HIGH', steps: [skill('golpe')] },
          { priority: 'MEDIUM', steps: [skill('embate')] },
          { priority: 'LOW', steps: [basic] },
        ],
      ),
    )
    expect(actions.slice(0, 3).map((action) => action.abilityId)).toEqual(['golpe', 'embate', null])
    expect(actions[2]).toMatchObject({
      action: 'BASIC_ATTACK',
      strategy: {
        rotation: 'LOW',
        step: 1,
        fallback: false,
        skipped: [
          { rotation: 'HIGH', step: 1, reason: 'ON_COOLDOWN' },
          { rotation: 'MEDIUM', step: 1, reason: 'ON_COOLDOWN' },
        ],
      },
    })
  })

  it('D-4 (CA-03): with no viable rotation the hero uses the fallback basic attack', async () => {
    const actions = await heroActions(
      duel(
        [damageSkill('costosa', 10), damageSkill('carisima', 20)],
        [
          { priority: 'HIGH', steps: [skill('costosa')] },
          { priority: 'MEDIUM', steps: [skill('carisima')] },
        ],
      ),
    )
    expect(actions.length).toBeGreaterThan(0)
    for (const action of actions) {
      expect(action).toMatchObject({
        action: 'BASIC_ATTACK',
        abilityId: null,
        strategy: { rotation: null, step: null, fallback: true },
      })
    }
  })

  it('course example (7.8.5): the medium rotation acts while the high one recharges', async () => {
    const actions = await heroActions(
      duel(
        [
          damageSkill('golpe-de-tormenta', 1, 3),
          damageSkill('embate-sangriento', 1, 3),
          damageSkill('lanza-de-los-dioses', 1, 3),
        ],
        [
          {
            priority: 'HIGH',
            steps: [skill('golpe-de-tormenta'), skill('embate-sangriento'), basic],
          },
          { priority: 'MEDIUM', steps: [skill('lanza-de-los-dioses'), basic, basic] },
          { priority: 'LOW', steps: [skill('embate-sangriento'), basic, basic] },
        ],
      ),
    )
    expect(actions.slice(0, 4).map((action) => action.abilityId)).toEqual([
      'golpe-de-tormenta',
      'embate-sangriento',
      null,
      'lanza-de-los-dioses',
    ])
    expect(actions[3]).toMatchObject({
      strategy: {
        rotation: 'MEDIUM',
        step: 1,
        // La prioridad es estricta: al encontrar MEDIUM viable, LOW no se evalua.
        skipped: [{ rotation: 'HIGH', step: 1, reason: 'ON_COOLDOWN' }],
      },
    })
  })

  it('P-R6: a rotation that is not viable keeps its cursor', async () => {
    const actions = await heroActions(
      duel(
        [damageSkill('golpe', 1, 3)],
        [
          { priority: 'HIGH', steps: [skill('golpe'), basic] },
          { priority: 'MEDIUM', steps: [basic] },
        ],
      ),
    )
    const rotations = actions
      .slice(0, 5)
      .map((action) => (action.strategy as { rotation: string }).rotation)
    expect(rotations).toEqual(['HIGH', 'HIGH', 'MEDIUM', 'MEDIUM', 'HIGH'])
    for (const turn of [2, 3]) {
      expect(actions[turn]).toMatchObject({
        strategy: { skipped: [{ rotation: 'HIGH', step: 1, reason: 'ON_COOLDOWN' }] },
      })
    }
    expect(actions[4]).toMatchObject({
      abilityId: 'golpe',
      strategy: { rotation: 'HIGH', step: 1 },
    })
  })

  it('logs an ability whose effect Combat cannot execute instead of skipping it silently', async () => {
    const dardo: CombatAbility = {
      ...damageSkill('dardo', 1),
      effects: [
        {
          kind: 'STAT_MODIFIER',
          target: 'ENEMY',
          statistic: 'DEFENSE',
          operation: 'DECREASE',
          magnitude: { mode: 'FIXED', amount: 1 },
          hasActivationCondition: false,
        },
      ],
    }
    const actions = await heroActions(
      duel(
        [dardo],
        [
          { priority: 'HIGH', steps: [skill('dardo')] },
          { priority: 'MEDIUM', steps: [basic] },
        ],
      ),
    )
    expect(actions[0]).toMatchObject({
      action: 'BASIC_ATTACK',
      strategy: {
        rotation: 'MEDIUM',
        step: 1,
        skipped: [{ rotation: 'HIGH', step: 1, reason: 'UNSUPPORTED_EFFECT' }],
      },
    })
  })

  it('skips an ability the hero does not have as UNKNOWN_ABILITY', async () => {
    const actions = await heroActions(duel([], [{ priority: 'HIGH', steps: [skill('no-existe')] }]))
    expect(actions[0]).toMatchObject({
      action: 'BASIC_ATTACK',
      strategy: {
        fallback: true,
        skipped: [{ rotation: 'HIGH', step: 1, reason: 'UNKNOWN_ABILITY' }],
      },
    })
  })
})

describe('pure support mission turns (HU-71 PO clarification)', () => {
  const supportRequest = (
    abilities: readonly CombatAbility[],
    rotations: readonly {
      readonly priority: 'HIGH' | 'MEDIUM' | 'LOW'
      readonly steps: readonly Step[]
    }[],
  ): MissionSimulationRequest => {
    const request = duel(abilities, rotations)
    return {
      ...request,
      operationId: `mission:support:${abilities.map((ability) => ability.abilityId).join('-')}`,
      hero: {
        ...request.hero,
        profile: {
          ...request.hero.profile,
          subtype: 'MEDICO',
          effectiveStats: {
            ...request.hero.profile.effectiveStats,
            health: 100,
            attack: null,
            damage: null,
          },
        },
      },
      encounters: [
        {
          index: 1,
          kind: 'REGULAR',
          powerStep: 0,
          enemies: [
            { enemyRef: 'dummy', name: 'Dummy', count: 1, profile: fighter(1000, 100, 0, 20) },
          ],
        },
      ],
      rules: { ...request.rules!, maxTurnsPerEncounter: 2, supportRegen: 0 },
    }
  }

  it('ends the turn without invoking a policy or inventing basic attack/damage', async () => {
    const request = supportRequest([], [])
    const decide = jest.fn()
    const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
    const seed = new HmacMissionSeedFactory('test-secret').forOperation(request.operationId)
    const result = await simulateMission(request, seed, factory, { decide })
    const actions = result.combatLog.filter((event) => event.type === 'heroAction')

    expect(decide).not.toHaveBeenCalled()
    expect(actions).toHaveLength(2)
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'END_TURN', hit: false, damage: 0, attacked: false }),
      ]),
    )
    expect(result.summary).toMatchObject({ damageDealt: 0, abilityDamage: 0, skillsUsed: [] })
  })

  it('uses a legal heal after damage, but never offers the offensive fallback', async () => {
    const heal: CombatAbility = {
      abilityId: 'curar',
      name: 'curar',
      powerCost: { mode: 'FIXED', amount: 1 },
      chargeTurns: 1,
      effects: [
        {
          kind: 'HEALING',
          target: 'SELF',
          magnitude: { mode: 'FIXED', amount: 30 },
          hasActivationCondition: false,
        },
      ],
    }
    const request = supportRequest([heal], [{ priority: 'HIGH', steps: [skill('curar')] }])
    const result = await logOf(request)
    const actions = result.combatLog.filter((event) => event.type === 'heroAction')

    expect(actions[0]).toMatchObject({ action: 'END_TURN', damage: 0, attacked: false })
    expect(actions[1]).toMatchObject({
      action: 'ABILITY',
      abilityId: 'curar',
      damage: 0,
      attacked: false,
      powerSpent: 1,
    })
  })
})

/** Habilidad de un solo efecto, con recarga de 1 turno y costo 1. */
const utility = (
  abilityId: string,
  effect: Omit<CombatAbility['effects'][number], 'hasActivationCondition'>,
): CombatAbility => ({
  abilityId,
  name: abilityId,
  powerCost: { mode: 'FIXED', amount: 1 },
  chargeTurns: 1,
  effects: [{ ...effect, hasActivationCondition: false }],
})

/**
 * Duelo contra un enemigo que SIEMPRE acierta (ataque 30 contra defensa 8) y hace
 * 5 de dano, sin poder caer: cada ronda muestra el efecto de la habilidad.
 */
const brawl = (
  abilities: readonly CombatAbility[],
  steps: readonly Step[],
): MissionSimulationRequest => {
  const base = duel(abilities, [{ priority: 'HIGH', steps }])
  return {
    ...base,
    operationId: `mission:brawl:${steps.map((s) => (s.kind === 'ABILITY' ? s.abilityId : 'basic')).join('-')}`,
    encounters: [
      {
        index: 1,
        kind: 'REGULAR',
        powerStep: 0,
        enemies: [{ enemyRef: 'ogro', name: 'Ogro', count: 1, profile: fighter(100000, 30, 0, 5) }],
      },
    ],
  }
}

const logOf = async (request: MissionSimulationRequest) => {
  const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
  const seed = new HmacMissionSeedFactory('test-secret').forOperation(request.operationId)
  return simulateMission(request, seed, factory, new RuleBasedPolicy())
}

/**
 * Mismo heroe, con `effectiveStats.health` mas bajo (ADR-023, EN-035.3): la
 * curacion solo es candidata estrategica con `healthRatio < 0.90`, asi que
 * las pruebas de mecanica de curacion necesitan al heroe ya por debajo de ese
 * umbral antes del paso de curacion, no a salud completa.
 */
const withMaxHealth = (
  request: MissionSimulationRequest,
  health: number,
): MissionSimulationRequest => ({
  ...request,
  hero: {
    ...request.hero,
    profile: {
      ...request.hero.profile,
      effectiveStats: { ...request.hero.profile.effectiveStats, health },
    },
  },
})

describe('mission abilities beyond attack bonuses (P-J4)', () => {
  it('direct damage hits without an attack roll and counts as ability damage', async () => {
    const result = await logOf(
      brawl(
        [
          utility('agonia', {
            kind: 'DAMAGE',
            target: 'OPPONENT',
            magnitude: { mode: 'FIXED', amount: 7 },
          }),
        ],
        [skill('agonia'), basic],
      ),
    )
    const [first] = result.combatLog.filter((event) => event.type === 'heroAction')
    expect(first).toMatchObject({
      action: 'ABILITY',
      abilityId: 'agonia',
      attacked: false,
      hit: false,
      damage: 0,
      powerSpent: 1,
      effects: [{ kind: 'DIRECT_DAMAGE', amount: 7 }],
    })
    expect(result.summary).toMatchObject({ skillsUsed: [{ abilityId: 'agonia', count: 3 }] })
    expect(result.summary.abilityDamage).toBe(21)
  })

  it('heals the hero now and, with duration, at the start of the next round', async () => {
    const result = await logOf(
      withMaxHealth(
        brawl(
          [
            utility('canto', {
              kind: 'HEALING',
              target: 'ALLIED_GROUP',
              magnitude: { mode: 'FIXED', amount: 3 },
              durationTurns: 2,
            }),
          ],
          [basic, skill('canto'), basic],
        ),
        // Con 1 ataque enemigo de 5 antes de curar, 40 de salud maxima baja al
        // 87,5 % (< 90 %): la curacion ya es candidata estrategica (ADR-023).
        40,
      ),
    )
    const heroActions = result.combatLog.filter((event) => event.type === 'heroAction')
    expect(heroActions[1]).toMatchObject({
      effects: [{ kind: 'HEAL', amount: 3, turns: 2, heroHealth: 38 }],
    })
    const secondRound = result.combatLog.findIndex((event) => event === heroActions[1])
    const nextHeal = result.combatLog
      .slice(secondRound)
      .find((event) => event.type === 'heroHealed')
    expect(nextHeal).toMatchObject({ amount: 3 })
    expect(result.summary.healingDone).toBeGreaterThanOrEqual(6)
  })

  it('heals a percentage of the maximum health (PvP Reanimacion semantics)', async () => {
    const result = await logOf(
      withMaxHealth(
        brawl(
          [
            utility('reanimacion', {
              kind: 'REVIVE',
              target: 'ALLY',
              magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
            }),
          ],
          [basic, basic, skill('reanimacion')],
        ),
        // 2 ataques enemigos de 5 antes de curar, sobre 90 de salud maxima,
        // bajan al 88,9 % (< 90 %): la curacion ya es candidata (ADR-023).
        90,
      ),
    )
    const [, , third] = result.combatLog.filter((event) => event.type === 'heroAction')
    expect(third).toMatchObject({ effects: [{ kind: 'HEAL', amount: 10, heroHealth: 90 }] })
  })

  it('immunity prevents the damage of that round', async () => {
    const result = await logOf(
      brawl([utility('defensa', { kind: 'IMMUNITY', target: 'SELF' })], [skill('defensa'), basic]),
    )
    const enemyActions = result.combatLog.filter((event) => event.type === 'enemyAction')
    expect(enemyActions[0]).toMatchObject({ hit: true, damage: 0, prevented: 5, heroHealth: 1000 })
    expect(enemyActions[1]).toMatchObject({ hit: true, damage: 5 })
  })

  it('a defense buff makes the enemy miss, and ends when its rounds are spent', async () => {
    const result = await logOf(
      brawl(
        [
          utility('piedra', {
            kind: 'STAT_MODIFIER',
            target: 'SELF',
            statistic: 'DEFENSE',
            operation: 'INCREASE',
            magnitude: { mode: 'FIXED', amount: 50 },
            durationTurns: 2,
          }),
        ],
        [skill('piedra'), basic, basic],
      ),
    )
    const enemyActions = result.combatLog.filter((event) => event.type === 'enemyAction')
    expect(enemyActions.slice(0, 3).map((event) => event.hit)).toEqual([false, false, true])
  })

  it('a debuff lowers the opponent attack while it lasts', async () => {
    const result = await logOf(
      brawl(
        [
          utility('cono', {
            kind: 'STAT_MODIFIER',
            target: 'OPPONENT',
            statistic: 'ATTACK',
            operation: 'DECREASE',
            magnitude: { mode: 'FIXED', amount: 100 },
            durationTurns: 2,
          }),
        ],
        [skill('cono'), basic, basic],
      ),
    )
    const heroActions = result.combatLog.filter((event) => event.type === 'heroAction')
    expect(heroActions[0]).toMatchObject({
      attacked: false,
      effects: [{ kind: 'DEBUFF', statistic: 'ATTACK', amount: 100, turns: 2 }],
    })
    const enemyActions = result.combatLog.filter((event) => event.type === 'enemyAction')
    expect(enemyActions.slice(0, 3).map((event) => event.hit)).toEqual([false, false, true])
  })

  it('a damage reduction can soften a hit down to zero', async () => {
    const result = await logOf(
      brawl(
        [
          utility('hielo', {
            kind: 'STAT_MODIFIER',
            target: 'OPPONENT',
            statistic: 'DAMAGE',
            operation: 'DECREASE',
            magnitude: { mode: 'FIXED', amount: 10 },
          }),
        ],
        [skill('hielo'), basic],
      ),
    )
    const enemyActions = result.combatLog.filter((event) => event.type === 'enemyAction')
    expect(enemyActions[0]).toMatchObject({ hit: true, damage: 0 })
    expect(enemyActions[1]).toMatchObject({ hit: true, damage: 5 })
  })

  it('reflect returns part of the damage to the attacker', async () => {
    const result = await logOf(
      brawl(
        [
          utility('toma', {
            kind: 'REFLECT_DAMAGE',
            target: 'OPPONENT',
            magnitude: { mode: 'PERCENTAGE', basisPoints: 6000 },
          }),
        ],
        [skill('toma'), basic],
      ),
    )
    const enemyActions = result.combatLog.filter((event) => event.type === 'enemyAction')
    expect(enemyActions[0]).toMatchObject({ hit: true, damage: 2, reflected: 3 })
    // Se usa en las rondas 1, 3 y 5 del duelo de 6: tres reflejos de 3.
    const reflected = enemyActions.map((event) => Number(event.reflected ?? 0))
    expect(reflected.filter((amount) => amount > 0)).toEqual([3, 3, 3])
    expect(result.summary.abilityDamage).toBe(9)
  })

  it('a damage buff with duration also improves the following basic attacks', async () => {
    const result = await logOf(
      brawl(
        [
          utility('cortada', {
            kind: 'STAT_MODIFIER',
            target: 'SELF',
            statistic: 'DAMAGE',
            operation: 'INCREASE',
            magnitude: { mode: 'FIXED', amount: 40 },
            durationTurns: 2,
          }),
        ],
        [skill('cortada'), basic, basic],
      ),
    )
    const heroActions = result.combatLog.filter((event) => event.type === 'heroAction')
    expect(heroActions[0]).toMatchObject({
      action: 'ABILITY',
      hit: true,
      effects: [{ kind: 'BUFF', statistic: 'DAMAGE', amount: 40, turns: 2 }],
    })
    expect(heroActions[0]?.damage).toBeGreaterThanOrEqual(41)
    expect(heroActions[1]?.damage).toBeGreaterThanOrEqual(41)
    expect(heroActions[2]?.damage).toBeLessThan(41)
  })

  it('reflected damage can finish the enemy during its own attack', async () => {
    const request = brawl(
      [
        utility('espejo', {
          kind: 'REFLECT_DAMAGE',
          target: 'OPPONENT',
          magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
          durationTurns: 3,
        }),
      ],
      [skill('espejo'), basic],
    )
    const result = await logOf({
      ...request,
      encounters: [
        {
          index: 1,
          kind: 'REGULAR',
          powerStep: 0,
          enemies: [{ enemyRef: 'ogro', name: 'Ogro', count: 1, profile: fighter(5, 30, 50, 5) }],
        },
      ],
    })
    expect(result.combatLog).toContainEqual(
      expect.objectContaining({ type: 'enemyAction', damage: 0, reflected: 5 }),
    )
    expect(result.combatLog).toContainEqual(
      expect.objectContaining({ type: 'combatantDefeated', combatant: 'ogro#1' }),
    )
    expect(result.combatOutcome).toBe('HERO_VICTORIOUS')
  })
})
