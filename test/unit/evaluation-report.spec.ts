import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import {
  EVALUATION_MATCH_RESULT_VERSION,
  type EvaluationMatchResultV1,
} from '../../src/evaluation/battle/EvaluationMatchResult'
import type { EvaluationConfig } from '../../src/evaluation/experiment/EvaluationConfig'
import {
  buildEvaluationSummary,
  buildMatchesJsonl,
  matchesSha256Of,
} from '../../src/evaluation/experiment/EvaluationReport'

const config: EvaluationConfig = {
  configVersion: 'evaluation-config-v1',
  purpose: 'SMOKE_TEST',
  scenarioIds: ['scenario-1'],
  matchups: [['RANDOM', 'RULE_BASED']],
  seedStart: 1,
  seedCount: 2,
  mctsSeedCount: 1,
  mctsConfig: MCTS_TEACHER_V1_CONFIG,
  maxPlies: 200,
  mirrorEnabled: true,
  neuralArtifact: null,
  skipExpensiveMcts: false,
  sourceCommit: 'test-commit',
}

const match = (overrides: Partial<EvaluationMatchResultV1> = {}): EvaluationMatchResultV1 => ({
  schemaVersion: EVALUATION_MATCH_RESULT_VERSION,
  evaluationId: 'eval-test',
  matchId: 'match-1',
  mirrorPairId: 'pair-1',
  mirrorLeg: 'LEG_1',
  matchupId: 'RANDOM_vs_RULE_BASED',
  scenarioId: 'scenario-1',
  matchSeed: 1,
  combatSeed: 1,
  policyA: 'RANDOM',
  policyB: 'RULE_BASED',
  status: 'COMPLETED',
  policyFailureCode: null,
  failedSide: null,
  outcome: { outcome: 'WIN', winnerSide: 'A', reason: 'ELIMINATION' },
  plies: 5,
  turnsCompleted: 3,
  decisionCount: 5,
  systemEndTurns: 0,
  invalidPolicySelections: 0,
  engineRejections: 0,
  metricsBySide: {
    A: {
      damageDealt: 20,
      healingDone: 0,
      decisions: 3,
      actionKindCount: { BASIC_ATTACK: 3, ABILITY: 0, EPIC: 0 },
      finalPower: null,
      finalHealth: { remaining: 44, max: 44, lifePercent: 1 },
    },
    B: {
      damageDealt: 0,
      healingDone: 0,
      decisions: 2,
      actionKindCount: { BASIC_ATTACK: 2, ABILITY: 0, EPIC: 0 },
      finalPower: null,
      finalHealth: { remaining: 0, max: 44, lifePercent: 0 },
    },
  },
  ...overrides,
})

describe('EvaluationReport (EN-036.5, Management #569 §46-47, §58, §81, §176)', () => {
  it('fingerprint comparable ignora rutas temporales pero conserva el hash completo para trazabilidad', () => {
    const withArtifact = (root: string): EvaluationConfig => ({
      ...config,
      neuralArtifact: {
        onnxPath: `${root}/model.onnx`,
        manifestPath: `${root}/training-manifest.json`,
        allowSmokeModel: false,
        inferenceTimeoutMs: 2_000,
      },
    })
    const first = buildEvaluationSummary({
      evaluationId: 'first',
      config: withArtifact('active-baseline'),
      results: [match()],
      model: null,
      parity: null,
    })
    const second = buildEvaluationSummary({
      evaluationId: 'second',
      config: withArtifact('candidate'),
      results: [match()],
      model: null,
      parity: null,
    })
    expect(first.fingerprints.evaluationProtocolSha256).toBe(
      second.fingerprints.evaluationProtocolSha256,
    )
    expect(first.fingerprints.evaluationConfigSha256).not.toBe(
      second.fingerprints.evaluationConfigSha256,
    )
  })

  it('RP-01/RP-02: los conteos de summary reconcilian con los resultados', () => {
    const results = [
      match(),
      match({
        matchId: 'match-2',
        outcome: { outcome: 'WIN', winnerSide: 'B', reason: 'ELIMINATION' },
      }),
    ]
    const summary = buildEvaluationSummary({
      evaluationId: 'eval-test',
      config,
      results,
      model: null,
      parity: null,
    })

    expect(summary.totalMatches).toBe(2)
    const randomRow = summary.policySummary.find((r) => r.policyId === 'RANDOM')
    const ruleRow = summary.policySummary.find((r) => r.policyId === 'RULE_BASED')
    expect(randomRow).toMatchObject({ battles: 2, wins: 1, losses: 1, draws: 0, failures: 0 })
    expect(ruleRow).toMatchObject({ battles: 2, wins: 1, losses: 1, draws: 0, failures: 0 })

    const matchupRow = summary.matchupSummary[0]
    expect(matchupRow).toMatchObject({
      n: 2,
      firstPolicyWins: 1,
      secondPolicyWins: 1,
      draws: 0,
      failures: 0,
    })
  })

  it('RP-03: invalidPolicySelections global es la suma de las individuales', () => {
    const results = [
      match({ invalidPolicySelections: 1 }),
      match({ matchId: 'm2', invalidPolicySelections: 2 }),
    ]
    const summary = buildEvaluationSummary({
      evaluationId: 'eval-test',
      config,
      results,
      model: null,
      parity: null,
    })
    expect(summary.globalInvalidPolicySelections).toBe(3)
  })

  it('MT-07: una partida FAILED no entra silenciosamente en wins/losses, cuenta como failure', () => {
    const results = [match({ status: 'ENGINE_FAILURE', outcome: null, failedSide: null })]
    const summary = buildEvaluationSummary({
      evaluationId: 'eval-test',
      config,
      results,
      model: null,
      parity: null,
    })
    const randomRow = summary.policySummary.find((r) => r.policyId === 'RANDOM')
    expect(randomRow).toMatchObject({ wins: 0, losses: 0, draws: 0, failures: 1, battles: 1 })
    expect(randomRow?.winRate).toBeNull()
  })

  it('#569 §176: un promedio sin datos es null, nunca NaN/Infinity', () => {
    const results = [match({ status: 'POLICY_FAILURE', outcome: null, failedSide: 'A' })]
    const summary = buildEvaluationSummary({
      evaluationId: 'eval-test',
      config,
      results,
      model: null,
      parity: null,
    })
    const randomRow = summary.policySummary.find((r) => r.policyId === 'RANDOM')
    expect(randomRow?.avgDamageDealt).toBeNull()
    expect(Number.isNaN(randomRow?.avgDamageDealt)).toBe(false)
  })

  it('RP-04/RP-05: orden JSON determinista -> mismo hash para el mismo contenido en cualquier orden de entrada', () => {
    const a = match()
    const b = match({ matchId: 'match-2' })

    expect(matchesSha256Of([a, b])).toBe(matchesSha256Of([b, a]))
    expect(buildMatchesJsonl([a, b])).toBe(buildMatchesJsonl([b, a]))
  })

  it('matchesSha256 cambia si el contenido de una partida cambia', () => {
    const a = match()
    const changed = match({ plies: 999 })
    expect(matchesSha256Of([a])).not.toBe(matchesSha256Of([changed]))
  })

  it(
    'regresion de revision (#569): un POLICY_FAILURE con failedSide=A nunca entra al ' +
      'denominador de winRate de NINGUNA de las dos politicas (ni la que fallo ni la rival)',
    () => {
      const results = [
        match({ matchId: 'm1' }), // A (RANDOM) gana
        match({ matchId: 'm2' }), // A (RANDOM) gana
        match({
          matchId: 'm3',
          status: 'POLICY_FAILURE',
          policyFailureCode: 'RANDOM_POLICY_ERROR',
          failedSide: 'A',
          outcome: null,
        }),
      ]
      const summary = buildEvaluationSummary({
        evaluationId: 'eval-test',
        config,
        results,
        model: null,
        parity: null,
      })

      const randomRow = summary.policySummary.find((r) => r.policyId === 'RANDOM')
      const ruleRow = summary.policySummary.find((r) => r.policyId === 'RULE_BASED')

      // RANDOM: 3 apariciones, pero solo 2 completadas (gano las 2) -- el
      // denominador de winRate es 2, NUNCA 3 (antes `battles - failures`
      // daba 3 - 1 = 2 por casualidad aqui, pero solo porque RANDOM fue
      // quien causo el fallo; el bug real aparecia del lado de RULE_BASED).
      expect(randomRow).toMatchObject({
        battles: 3,
        completedBattles: 2,
        wins: 2,
        losses: 0,
        failures: 1,
        failuresCaused: 1,
      })
      expect(randomRow?.winRate).toBe(1)

      // RULE_BASED: 3 apariciones, 2 completadas (perdio las 2), 1 fallo
      // AJENO (failedSide='A', nunca "causado" por RULE_BASED). El bug
      // original hacia `completed = battles - failures = 3 - 0 = 3` para
      // este lado (porque RULE_BASED nunca sumaba a `failures`), inflando
      // el denominador con una partida que RULE_BASED jamas completo.
      expect(ruleRow).toMatchObject({
        battles: 3,
        completedBattles: 2,
        wins: 0,
        losses: 2,
        failures: 1,
        failuresCaused: 0,
      })
      expect(ruleRow?.winRate).toBe(0)
    },
  )

  it('matchup SKIPPED_COST (sin partidas) se marca explicitamente, nunca como 0 resultados silencioso', () => {
    const configWithMcts: EvaluationConfig = { ...config, matchups: [['MCTS', 'RANDOM']] }
    const summary = buildEvaluationSummary({
      evaluationId: 'eval-test',
      config: configWithMcts,
      results: [],
      model: null,
      parity: null,
    })
    expect(summary.matchupSummary[0]).toMatchObject({ skippedForCost: true, n: 0 })
  })
})
