import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { HmacMissionSeedFactory } from '../../src/adapters/outbound/system/HmacMissionSeedFactory'
import {
  simulateMission,
  type MissionSimulationRequest,
} from '../../src/application/services/MissionSimulation'
import type { AiDecisionPort } from '../../src/application/ports/AiDecisionPort'
import type { BattleDecisionState } from '../../src/domain/decision/BattleDecisionState'
import type { ActionIntent } from '../../src/domain/decision/ActionIntent'
import type { LegalAction } from '../../src/domain/decision/LegalAction'
import type { CombatAbility } from '../../src/domain/entities/CombatProfile'

/** Captura cada `BattleDecisionState`/`legalActions` que recibe, y decide como `RuleBasedPolicy` (primera candidata). */
class ProbePolicy implements AiDecisionPort {
  readonly states: BattleDecisionState[] = []
  readonly offered: (readonly LegalAction[])[] = []

  decide(state: BattleDecisionState, legalActions: readonly LegalAction[]): Promise<ActionIntent> {
    this.states.push(state)
    this.offered.push(legalActions)
    const [first] = legalActions

    if (first === undefined) throw new Error('sin candidatas')

    return Promise.resolve(first)
  }
}

const cortada: CombatAbility = {
  abilityId: 'cortada',
  name: 'cortada',
  powerCost: { mode: 'FIXED', amount: 1 },
  chargeTurns: 0,
  effects: [
    {
      kind: 'STAT_MODIFIER',
      target: 'SELF',
      statistic: 'DAMAGE',
      operation: 'INCREASE',
      magnitude: { mode: 'FIXED', amount: 40 },
      durationTurns: 2,
      hasActivationCondition: false,
    },
  ],
}

const request: MissionSimulationRequest = {
  schemaVersion: 1,
  operationId: 'mission:decision-state-probe:simulate',
  enrollmentId: 'probe',
  missionId: 'msn_probe',
  difficulty: 'NORMAL',
  enemyStatMultiplier: 1,
  timeBudget: 'PT12H',
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
      abilities: [cortada],
    },
  },
  strategy: {
    version: 1,
    rotations: [
      {
        priority: 'HIGH',
        steps: [{ kind: 'ABILITY', abilityId: 'cortada' }, { kind: 'BASIC_ATTACK' }],
      },
    ],
    fallback: 'BASIC_ATTACK',
  },
  encounters: [
    {
      index: 1,
      kind: 'REGULAR',
      powerStep: 0,
      enemies: [
        {
          enemyRef: 'ogro',
          name: 'Ogro',
          count: 1,
          profile: {
            maxHealth: 100_000,
            attack: 30,
            defense: 8,
            damage: { mode: 'FIXED', amount: 5 },
            ai: 'AGGRESSIVE',
          },
        },
      ],
    },
  ],
  rules: {
    turnDurationSeconds: 60,
    maxTurnsPerEncounter: 3,
    recoveryPercent: 35,
    criticalChance: 0.1,
    criticalMultiplier: 1.5,
  },
  bossDrops: [],
  master: null,
}

describe('BattleDecisionState construido por MissionSimulation (revisión de PR #71)', () => {
  it('representa las estadísticas reales del enemigo, nunca null por pereza', async () => {
    const probe = new ProbePolicy()
    const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
    const seed = new HmacMissionSeedFactory('test-secret').forOperation(request.operationId)

    await simulateMission(request, seed, factory, probe)

    const [firstState] = probe.states

    expect(firstState).toBeDefined()
    expect(firstState?.enemies[0]).toMatchObject({
      attack: 30,
      defense: 8,
      damage: { mode: 'FIXED', amount: 5 },
      health: { current: 100_000, max: 100_000 },
    })
  })

  it('representa en activeEffects un buff propio con duración, con su habilidad de origen real', async () => {
    const probe = new ProbePolicy()
    const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
    const seed = new HmacMissionSeedFactory('test-secret').forOperation(request.operationId)

    await simulateMission(request, seed, factory, probe)

    // Turno 1: cortada (sin buff activo todavía al decidir). Turno 2: ya debería
    // verse el buff que cortada acaba de dejar activo en el turno 1.
    const secondState = probe.states[1]

    expect(secondState?.actor.activeEffects).toEqual([
      {
        kind: 'STAT',
        sourceAbilityId: 'cortada',
        sourceCombatant: { teamLabel: 'HERO', seat: 0 },
        statistic: 'DAMAGE',
        operation: 'INCREASE',
        amount: 40,
        remainingOwnTurns: expect.any(Number),
      },
    ])
  })
})
