import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { HmacMissionSeedFactory } from '../../src/adapters/outbound/system/HmacMissionSeedFactory'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { InMemoryCombatDecisionTelemetryRepository } from '../../src/adapters/outbound/persistence/InMemoryCombatDecisionTelemetryRepository'
import { InMemoryMissionSimulationIntakeRepository } from '../../src/adapters/outbound/persistence/InMemoryMissionSimulationIntakeRepository'
import { Sha256CommandIdFingerprint } from '../../src/adapters/outbound/system/Sha256CommandIdFingerprint'
import { RuleBasedPolicy } from '../../src/application/policies/RuleBasedPolicy'
import { DecisionPolicySelector } from '../../src/application/services/DecisionPolicySelector'
import { CombatDecisionRecorder } from '../../src/application/services/CombatDecisionRecorder'
import type { MissionSimulationRequest } from '../../src/application/services/MissionSimulation'
import { EstimateMissionOutcome } from '../../src/application/use-cases/EstimateMissionOutcome'
import { RunMissionSimulation } from '../../src/application/use-cases/RunMissionSimulation'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiDecisionPort } from '../../src/application/ports/AiDecisionPort'

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
const ruleBasedSelector = (): DecisionPolicySelector =>
  new DecisionPolicySelector(null, { policy: new RuleBasedPolicy(), source: 'RULE_BASED' })

describe('mission decision telemetry', () => {
  const runWithSelector = async (
    missionRequest: MissionSimulationRequest,
    selector: DecisionPolicySelector,
    requestHash = 'c'.repeat(64),
  ) => {
    const intake = new InMemoryMissionSimulationIntakeRepository()
    const telemetry = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(
      telemetry,
      clock,
      logger,
      new Sha256CommandIdFingerprint(),
    )
    await intake.insertIfAbsent(missionRequest.operationId, requestHash)
    await new RunMissionSimulation(intake, sequences, seeds, selector, recorder).execute(
      missionRequest,
      requestHash,
    )
    return telemetry.listDecisionsByBattle('MISSION', missionRequest.operationId)
  }

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
      ruleBasedSelector(),
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
    const preview = new EstimateMissionOutcome(sequences, seeds, ruleBasedSelector())

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
      ruleBasedSelector(),
      recorder,
    )

    await useCase.execute(supportRequest, requestHash)

    const decisions = await telemetry.listDecisionsByBattle('MISSION', supportOperationId)
    expect(decisions.filter((event) => event.actor.teamLabel === 'HERO')).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        decisionSource: 'SYSTEM',
        legalActions: [],
        selectedAction: { kind: 'END_TURN' },
      }),
    ])
  })

  it('records NEURAL only when the primary policy selected the executed legal action', async () => {
    const neural: AiDecisionPort = {
      decide: (_state, legalActions) => Promise.resolve(legalActions[0]!),
    }
    const fallback = { decide: jest.fn() }
    const decisions = await runWithSelector(
      { ...request, operationId: 'mission:telemetry-neural:simulate' },
      new DecisionPolicySelector(
        { policy: neural, source: 'NEURAL' },
        { policy: fallback, source: 'RULE_BASED' },
      ),
    )

    expect(decisions).not.toHaveLength(0)
    expect(decisions.every((event) => event.decisionSource === 'NEURAL')).toBe(true)
    expect(fallback.decide).not.toHaveBeenCalled()
  })

  it('records RULE_BASED when a neural primary invents an illegal action', async () => {
    const invalidNeural: AiDecisionPort = {
      decide: () =>
        Promise.resolve({
          kind: 'ABILITY',
          abilityId: 'not-offered',
          target: { scope: 'SELF' },
        }),
    }
    const decisions = await runWithSelector(
      { ...request, operationId: 'mission:telemetry-neural-fallback:simulate' },
      new DecisionPolicySelector(
        { policy: invalidNeural, source: 'NEURAL' },
        { policy: new RuleBasedPolicy(), source: 'RULE_BASED' },
      ),
    )

    expect(decisions).not.toHaveLength(0)
    expect(decisions.every((event) => event.decisionSource === 'RULE_BASED')).toBe(true)
  })

  it('routes an enemy attack through the selector with a non-player encounter identity', async () => {
    const enemyRequest: MissionSimulationRequest = {
      ...request,
      operationId: 'mission:telemetry-enemy:simulate',
      hero: {
        ...request.hero,
        profile: {
          ...request.hero.profile,
          effectiveStats: {
            ...request.hero.profile.effectiveStats,
            health: 100,
            attack: 1,
            damage: { mode: 'FIXED', amount: 1 },
          },
        },
      },
      encounters: [
        {
          index: 4,
          kind: 'REGULAR',
          powerStep: 0,
          enemies: [
            {
              enemyRef: 'sentinel',
              name: 'Sentinel',
              count: 1,
              profile: {
                maxHealth: 100,
                attack: 100,
                defense: 100,
                damage: { mode: 'FIXED', amount: 1 },
                ai: 'AGGRESSIVE',
              },
            },
          ],
        },
      ],
      rules: { ...request.rules!, maxTurnsPerEncounter: 1 },
    }
    const decisions = await runWithSelector(enemyRequest, ruleBasedSelector())
    const enemyDecision = decisions.find((event) => event.actor.teamLabel.startsWith('ENEMY:'))

    expect(enemyDecision).toMatchObject({
      decisionSource: 'RULE_BASED',
      actor: { teamLabel: 'ENEMY:4:sentinel', seat: 0 },
      selectedAction: {
        kind: 'BASIC_ATTACK',
        target: { scope: 'COMBATANT', combatant: { teamLabel: 'HERO', seat: 0 } },
      },
    })
    expect(enemyDecision?.legalActions).toHaveLength(1)
    expect(enemyDecision?.stateBefore.actor).toMatchObject({
      power: null,
      abilities: [],
      epic: null,
    })
  })
})
