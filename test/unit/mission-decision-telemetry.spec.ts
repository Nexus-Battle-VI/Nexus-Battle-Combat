import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { HmacMissionSeedFactory } from '../../src/adapters/outbound/system/HmacMissionSeedFactory'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { InMemoryCombatDecisionTelemetryRepository } from '../../src/adapters/outbound/persistence/InMemoryCombatDecisionTelemetryRepository'
import { InMemoryMissionSimulationIntakeRepository } from '../../src/adapters/outbound/persistence/InMemoryMissionSimulationIntakeRepository'
import { Sha256CommandIdFingerprint } from '../../src/adapters/outbound/system/Sha256CommandIdFingerprint'
import { RuleBasedPolicy } from '../../src/application/policies/RuleBasedPolicy'
import { CombatDecisionRecorder } from '../../src/application/services/CombatDecisionRecorder'
import type { MissionSimulationRequest } from '../../src/application/services/MissionSimulation'
import { EstimateMissionOutcome } from '../../src/application/use-cases/EstimateMissionOutcome'
import { RunMissionSimulation } from '../../src/application/use-cases/RunMissionSimulation'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const operationId = 'mission:telemetry-two-encounters:simulate'
const request: MissionSimulationRequest = {
  schemaVersion: 1,
  operationId,
  enrollmentId: 'telemetry-enrollment',
  missionId: 'telemetry-mission',
  difficulty: 'NORMAL',
  enemyStatMultiplier: 1,
  timeBudget: 'PT12H',
  hero: {
    heroId: 'hero-telemetry',
    profile: {
      subtype: 'GUERRERO_ARMAS',
      effectiveStats: {
        health: 100,
        power: 5,
        attack: 100,
        defense: 100,
        damage: { mode: 'FIXED', amount: 50 },
      },
      abilities: [],
    },
  },
  strategy: { version: null, rotations: [], fallback: 'BASIC_ATTACK' },
  encounters: [1, 2].map((index) => ({
    index,
    kind: index === 2 ? ('BOSS' as const) : ('REGULAR' as const),
    powerStep: 0,
    enemies: [
      {
        enemyRef: `enemy-${String(index)}`,
        name: `Enemy ${String(index)}`,
        count: 1,
        profile: {
          maxHealth: 1,
          attack: 0,
          defense: 0,
          damage: { mode: 'FIXED' as const, amount: 0 },
          ai: 'AGGRESSIVE' as const,
        },
      },
    ],
  })),
  rules: {
    turnDurationSeconds: 60,
    maxTurnsPerEncounter: 5,
    recoveryPercent: 35,
    criticalChance: 0,
    criticalMultiplier: 1.5,
  },
  bossDrops: [],
  master: null,
}

const sequences = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
const seeds = new HmacMissionSeedFactory('telemetry-test-secret')
const logger = { error: jest.fn() }
const clock = { now: (): Date => new Date('2026-10-04T12:00:00.000Z') }

describe('mission decision telemetry', () => {
  it('records real simulation decisions with one global sequence across encounters and one outcome', async () => {
    const intake = new InMemoryMissionSimulationIntakeRepository()
    const telemetry = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(
      telemetry,
      clock,
      logger,
      new Sha256CommandIdFingerprint(),
    )
    const requestHash = 'a'.repeat(64)
    await intake.insertIfAbsent(operationId, requestHash)
    const useCase = new RunMissionSimulation(
      intake,
      sequences,
      seeds,
      { policy: new RuleBasedPolicy(), source: 'RULE_BASED' },
      recorder,
    )

    const result = await useCase.execute(request, requestHash)
    const decisions = await telemetry.listDecisionsByBattle('MISSION', operationId)

    expect(result.combatOutcome).toBe('HERO_VICTORIOUS')
    expect(decisions).toHaveLength(2)
    expect(decisions.map((event) => event.decisionSequence)).toEqual([1, 2])
    expect(decisions.map((event) => event.stateBefore.context.turnsCompleted)).toEqual([0, 1])
    expect(new Set(decisions.map((event) => event.eventId)).size).toBe(decisions.length)
    expect(decisions.every((event) => event.decisionSource === 'RULE_BASED')).toBe(true)
    await expect(telemetry.findOutcome('MISSION', operationId)).resolves.toMatchObject({
      outcome: { kind: 'MISSION', outcome: 'HERO_VICTORIOUS' },
    })

    await useCase.execute(request, requestHash)
    await expect(telemetry.listDecisionsByBattle('MISSION', operationId)).resolves.toHaveLength(2)
  })

  it('does not persist any raw decision or outcome for preview estimations', async () => {
    const telemetry = new InMemoryCombatDecisionTelemetryRepository()
    const preview = new EstimateMissionOutcome(sequences, seeds, new RuleBasedPolicy())

    await preview.execute({ ...request, operationId: 'mission:preview:estimate' }, 30)

    await expect(
      telemetry.listDecisionsByBattle('MISSION', 'mission:preview:estimate'),
    ).resolves.toEqual([])
    await expect(telemetry.findOutcome('MISSION', 'mission:preview:estimate')).resolves.toBeNull()

    const source = readFileSync(
      join(process.cwd(), 'src/application/use-cases/EstimateMissionOutcome.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/CombatDecisionRecorder|CombatDecisionTelemetryRepository/)
  })

  it('records a pure-support turn with no legal action as SYSTEM END_TURN schema v2', async () => {
    const supportOperationId = 'mission:telemetry-support-end-turn:simulate'
    const supportRequest: MissionSimulationRequest = {
      ...request,
      operationId: supportOperationId,
      hero: {
        ...request.hero,
        profile: {
          ...request.hero.profile,
          subtype: 'CHAMAN',
          effectiveStats: {
            ...request.hero.profile.effectiveStats,
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
            {
              enemyRef: 'support-dummy',
              name: 'Support dummy',
              count: 1,
              profile: {
                maxHealth: 100,
                attack: 100,
                defense: 0,
                damage: { mode: 'FIXED', amount: 100 },
              },
            },
          ],
        },
      ],
      rules: { ...request.rules!, maxTurnsPerEncounter: 1, supportRegen: 0 },
    }
    const intake = new InMemoryMissionSimulationIntakeRepository()
    const telemetry = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(
      telemetry,
      clock,
      logger,
      new Sha256CommandIdFingerprint(),
    )
    const requestHash = 'b'.repeat(64)
    await intake.insertIfAbsent(supportOperationId, requestHash)
    const useCase = new RunMissionSimulation(
      intake,
      sequences,
      seeds,
      { policy: new RuleBasedPolicy(), source: 'RULE_BASED' },
      recorder,
    )

    await useCase.execute(supportRequest, requestHash)

    await expect(telemetry.listDecisionsByBattle('MISSION', supportOperationId)).resolves.toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        decisionSource: 'SYSTEM',
        legalActions: [],
        selectedAction: { kind: 'END_TURN' },
      }),
    ])
  })
})
