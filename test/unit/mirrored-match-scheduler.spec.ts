import {
  REQUIRED_EVALUATION_MATCHUPS,
  matchupId,
  type EvaluationConfig,
} from '../../src/evaluation/experiment/EvaluationConfig'
import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import { scheduleMirroredMatches } from '../../src/evaluation/experiment/MirroredMatchScheduler'

const baseConfig: EvaluationConfig = {
  configVersion: 'evaluation-config-v1',
  purpose: 'SMOKE_TEST',
  scenarioIds: ['scenario-1', 'scenario-2'],
  matchups: REQUIRED_EVALUATION_MATCHUPS,
  seedStart: 1000,
  seedCount: 3,
  mctsSeedCount: 2,
  mctsConfig: MCTS_TEACHER_V1_CONFIG,
  maxPlies: 200,
  mirrorEnabled: true,
  neuralArtifact: null,
  skipExpensiveMcts: false,
  sourceCommit: 'test-commit',
}

describe('scheduleMirroredMatches (EN-036.5, Management #569 §30-31, §83)', () => {
  it('MI-01/MI-02: cada par espejado asigna P y Q a AMBOS lados (A/B) con el MISMO root seed', () => {
    const plans = scheduleMirroredMatches(baseConfig)
    const randomVsRule = plans.filter(
      (p) =>
        p.matchupIdValue === matchupId(['RANDOM', 'RULE_BASED']) && p.scenarioId === 'scenario-1',
    )

    const byPairId = new Map<string, typeof randomVsRule>()
    for (const plan of randomVsRule) {
      byPairId.set(plan.mirrorPairId, [...(byPairId.get(plan.mirrorPairId) ?? []), plan])
    }

    expect(byPairId.size).toBe(baseConfig.seedCount)
    for (const [, pair] of byPairId) {
      expect(pair).toHaveLength(2)
      const [leg1, leg2] = pair
      expect(leg1?.mirrorPairId).toBe(leg2?.mirrorPairId)
      expect(leg1?.policyIdBySide).toEqual({ A: 'RANDOM', B: 'RULE_BASED' })
      expect(leg2?.policyIdBySide).toEqual({ A: 'RULE_BASED', B: 'RANDOM' })
    }
  })

  it('usa seedCount para matchups sin MCTS y mctsSeedCount (distinto) para matchups con MCTS', () => {
    const plans = scheduleMirroredMatches(baseConfig)
    const randomVsRuleSeeds = new Set(
      plans
        .filter((p) => p.matchupIdValue === matchupId(['RANDOM', 'RULE_BASED']))
        .map((p) => p.matchSeed),
    )
    const mctsVsRandomSeeds = new Set(
      plans
        .filter((p) => p.matchupIdValue === matchupId(['MCTS', 'RANDOM']))
        .map((p) => p.matchSeed),
    )

    expect(randomVsRuleSeeds.size).toBe(baseConfig.seedCount)
    expect(mctsVsRandomSeeds.size).toBe(baseConfig.mctsSeedCount)
  })

  it('skipExpensiveMcts omite TODOS los matchups con MCTS, deja el resto intacto', () => {
    const plans = scheduleMirroredMatches({ ...baseConfig, skipExpensiveMcts: true })
    const mctsPlans = plans.filter((p) => p.matchup.includes('MCTS'))
    const nonMctsPlans = plans.filter((p) => !p.matchup.includes('MCTS'))

    expect(mctsPlans).toHaveLength(0)
    expect(nonMctsPlans.length).toBeGreaterThan(0)
  })

  it('mirrorEnabled=false genera solo LEG_1, sin espejo', () => {
    const plans = scheduleMirroredMatches({ ...baseConfig, mirrorEnabled: false })
    expect(plans.every((p) => p.mirrorLeg === 'LEG_1')).toBe(true)
  })

  it('orden estable: escenario -> matchup -> seed -> leg', () => {
    const plans = scheduleMirroredMatches(baseConfig)
    const first = plans[0]
    expect(first?.scenarioId).toBe('scenario-1')
    expect(first?.matchupIdValue).toBe(matchupId(['RANDOM', 'RULE_BASED']))
    expect(first?.matchSeed).toBe(baseConfig.seedStart)
    expect(first?.mirrorLeg).toBe('LEG_1')
  })

  it('cada matchId es unico dentro del plan completo', () => {
    const plans = scheduleMirroredMatches(baseConfig)
    const ids = new Set(plans.map((p) => p.matchId))
    expect(ids.size).toBe(plans.length)
  })
})
