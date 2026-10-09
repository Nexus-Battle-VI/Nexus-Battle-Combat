import {
  evaluatePromotionPolicyV1,
  PROMOTION_POLICY_VERSION,
  type PromotionPolicyInput,
} from '../../src/application/promotion/PromotionPolicyV1'
import type {
  EvaluationSummary,
  MatchupSummaryRow,
  NeuralModelInfo,
  ParityReportSummary,
} from '../../src/evaluation/experiment/EvaluationReport'

const hex = (digit: string): string => digit.repeat(64)

const model: NeuralModelInfo = {
  modelArchitectureVersion: 'candidate-mlp-v1',
  featureSchemaVersion: 'feature-schema-v1',
  modelStateSha256: hex('1'),
  onnxArtifactSha256: hex('2'),
  artifactPurpose: 'CANDIDATE',
}

const passingParity: ParityReportSummary = {
  cases: 2,
  scoresCompared: 4,
  maxAbsoluteError: 1e-7,
  maxRelativeError: 1e-7,
  meanAbsoluteError: 1e-8,
  argmaxAgreement: 1,
  atol: 1e-5,
  rtol: 1e-5,
  passed: true,
}

/** `wins`/`n` controlan directamente `winRate = wins / (n - failures)`, con `failures=0` salvo que se indique. */
const matchupRow = (
  matchupId: string,
  firstPolicy: 'NEURAL',
  secondPolicy: 'RANDOM' | 'RULE_BASED',
  wins: number,
  n: number,
  overrides: Partial<MatchupSummaryRow> = {},
): MatchupSummaryRow => ({
  matchupId,
  firstPolicy,
  secondPolicy,
  n,
  firstPolicyWins: wins,
  secondPolicyWins: n - wins,
  draws: 0,
  failures: 0,
  skippedForCost: false,
  byScenario: [],
  ...overrides,
})

const baseSummary = (overrides: Partial<EvaluationSummary> = {}): EvaluationSummary => ({
  summarySchemaVersion: 'evaluation-summary-v1',
  evaluationId: 'eval-1',
  evaluationPurpose: 'FULL_EVALUATION',
  evaluationConfigVersion: 'evaluation-config-v1',
  scenarioVersion: 'evaluation-scenarios-v1',
  sourceCommit: 'abc123',
  model,
  parity: passingParity,
  totalMatches: 200,
  totalMirrorPairs: 100,
  globalInvalidPolicySelections: 0,
  globalEngineRejections: 0,
  policySummary: [],
  matchupSummary: [
    matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 60, 100),
    matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 50, 100),
  ],
  fingerprints: {
    evaluationConfigSha256: hex('a'),
    seedSetSha256: hex('b'),
    matchesSha256: hex('c'),
  },
  ...overrides,
})

const input = (overrides: Partial<PromotionPolicyInput> = {}): PromotionPolicyInput => ({
  candidateEvaluation: baseSummary(),
  activeBaselineEvaluation: null,
  ...overrides,
})

describe('PromotionPolicyV1 (EN-037.3, Management #572 §5, §14-A)', () => {
  it('GATE-01: exactamente 60% contra Random aprueba en el limite', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 60, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 50, 100),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('PASS')
    expect(decision.policyVersion).toBe(PROMOTION_POLICY_VERSION)
  })

  it('GATE-02: 59.99% contra Random falla', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 5999, 10000),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 50, 100),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('FAIL')
    if (decision.kind === 'FAIL') {
      expect(decision.reasons.some((reason) => reason.startsWith('PERFORMANCE_VS_RANDOM'))).toBe(
        true,
      )
    }
  })

  it('GATE-03: exactamente 50% contra RuleBased aprueba en el limite (umbral ratificado por el PO, ver docstring del modulo)', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 60, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 50, 100),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('PASS')
  })

  it('GATE-04: 49.99% contra RuleBased falla', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 60, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 4999, 10000),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('FAIL')
    if (decision.kind === 'FAIL') {
      expect(
        decision.reasons.some((reason) => reason.startsWith('PERFORMANCE_VS_RULE_BASED')),
      ).toBe(true)
    }
  })

  it('GATE-05: una accion ilegal (globalInvalidPolicySelections>0) fuerza FAIL aunque gane todas las partidas', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          globalInvalidPolicySelections: 1,
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 100, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 100, 100),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('FAIL')
    if (decision.kind === 'FAIL') {
      expect(decision.reasons.some((reason) => reason.startsWith('SAFETY'))).toBe(true)
    }
  })

  it('GATE-06: un rechazo del motor (globalEngineRejections>0) fuerza FAIL', () => {
    const decision = evaluatePromotionPolicyV1(
      input({ candidateEvaluation: baseSummary({ globalEngineRejections: 1 }) }),
    )
    expect(decision.kind).toBe('FAIL')
  })

  it('GATE-07: paridad FAIL fuerza FAIL', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({ parity: { ...passingParity, passed: false } }),
      }),
    )
    expect(decision.kind).toBe('FAIL')
    if (decision.kind === 'FAIL') {
      expect(decision.reasons.some((reason) => reason.startsWith('PARITY'))).toBe(true)
    }
  })

  it('GATE-08: paridad ausente (null) fuerza FAIL, nunca se interpreta como PASS por omision', () => {
    const decision = evaluatePromotionPolicyV1(
      input({ candidateEvaluation: baseSummary({ parity: null }) }),
    )
    expect(decision.kind).toBe('FAIL')
  })

  it('GATE-09: un reporte sin uno de los matchups obligatorios no pasa', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          matchupSummary: [matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 60, 100)],
        }),
      }),
    )
    expect(decision.kind).toBe('FAIL')
    if (decision.kind === 'FAIL') {
      expect(decision.reasons.some((reason) => reason.startsWith('EVIDENCE_COMPLETENESS'))).toBe(
        true,
      )
    }
  })

  it('GATE-10: SMOKE_TEST nunca puede promoverse, aunque todos los numeros sean perfectos', () => {
    const decision = evaluatePromotionPolicyV1(
      input({ candidateEvaluation: baseSummary({ evaluationPurpose: 'SMOKE_TEST' }) }),
    )
    expect(decision.kind).toBe('FAIL')
    if (decision.kind === 'FAIL') {
      expect(decision.reasons.some((reason) => reason.startsWith('EVIDENCE_COMPLETENESS'))).toBe(
        true,
      )
    }
  })

  it('GATE-11: un matchup SKIPPED_COST no cuenta como evidencia valida (nunca se usa el win rate global de NEURAL)', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 60, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 0, 0, {
              skippedForCost: true,
            }),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('FAIL')
  })

  it('GATE-12: los empates cuentan en el denominador pero nunca como victoria', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          matchupSummary: [
            // 60 wins, 0 losses, 40 draws -> completedMatches=100, winRate=60/100=60% (justo en el limite).
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 60, 100, {
              secondPolicyWins: 0,
              draws: 40,
            }),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 50, 100),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('PASS')
  })

  it('100% win rate + 1 accion ilegal -> FAIL (una metrica excelente nunca compensa un fallo de seguridad)', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          globalInvalidPolicySelections: 1,
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 100, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 100, 100),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('FAIL')
  })

  it('100% win rate + paridad FAIL -> FAIL', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          parity: { ...passingParity, passed: false },
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 100, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 100, 100),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('FAIL')
  })

  describe('gate de no-regresion vs ACTIVE (ampliacion ratificada por el PO)', () => {
    it('se omite (vacuously PASS) cuando no existe ningun ACTIVE vigente', () => {
      const decision = evaluatePromotionPolicyV1(input({ activeBaselineEvaluation: null }))
      expect(decision.kind).toBe('PASS')
      const gate = decision.gates.find((g) => g.gate === 'NON_REGRESSION_VS_ACTIVE')
      expect(gate?.passed).toBe(true)
    })

    it('FAIL cuando el candidato juega peor que el ACTIVE vigente en Random, aunque supere el 60% absoluto', () => {
      const sharedConfigSha256 = hex('d')
      const decision = evaluatePromotionPolicyV1({
        candidateEvaluation: baseSummary({
          fingerprints: {
            evaluationConfigSha256: sharedConfigSha256,
            seedSetSha256: hex('e'),
            matchesSha256: hex('f'),
          },
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 65, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 50, 100),
          ],
        }),
        activeBaselineEvaluation: baseSummary({
          fingerprints: {
            evaluationConfigSha256: sharedConfigSha256,
            seedSetSha256: hex('e'),
            matchesSha256: hex('f'),
          },
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 82, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 65, 100),
          ],
        }),
      })
      expect(decision.kind).toBe('FAIL')
      if (decision.kind === 'FAIL') {
        expect(
          decision.reasons.some((reason) => reason.startsWith('NON_REGRESSION_VS_ACTIVE')),
        ).toBe(true)
      }
    })

    it('PASS cuando el candidato iguala o supera al ACTIVE vigente en ambos matchups', () => {
      const sharedConfigSha256 = hex('d')
      const decision = evaluatePromotionPolicyV1({
        candidateEvaluation: baseSummary({
          fingerprints: {
            evaluationConfigSha256: sharedConfigSha256,
            seedSetSha256: hex('e'),
            matchesSha256: hex('f'),
          },
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 70, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 55, 100),
          ],
        }),
        activeBaselineEvaluation: baseSummary({
          fingerprints: {
            evaluationConfigSha256: sharedConfigSha256,
            seedSetSha256: hex('e'),
            matchesSha256: hex('f'),
          },
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 60, 100),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 50, 100),
          ],
        }),
      })
      expect(decision.kind).toBe('PASS')
    })

    it('fail-closed cuando el baseline del ACTIVE se evaluo con una configuracion distinta (no es apples-to-apples)', () => {
      const decision = evaluatePromotionPolicyV1({
        candidateEvaluation: baseSummary({
          fingerprints: {
            evaluationConfigSha256: hex('1'),
            seedSetSha256: hex('e'),
            matchesSha256: hex('f'),
          },
        }),
        activeBaselineEvaluation: baseSummary({
          fingerprints: {
            evaluationConfigSha256: hex('2'),
            seedSetSha256: hex('e'),
            matchesSha256: hex('f'),
          },
        }),
      })
      expect(decision.kind).toBe('FAIL')
      if (decision.kind === 'FAIL') {
        expect(
          decision.reasons.some((reason) => reason.startsWith('NON_REGRESSION_VS_ACTIVE')),
        ).toBe(true)
      }
    })
  })

  it('nunca divide por cero: un matchup con completedMatches=0 (todo fallas) nunca da winRate=0 silencioso', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 0, 10, {
              failures: 10,
              firstPolicyWins: 0,
              secondPolicyWins: 0,
            }),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 50, 100),
          ],
        }),
      }),
    )
    expect(decision.kind).toBe('FAIL')
    if (decision.kind === 'FAIL') {
      expect(
        decision.reasons.some(
          (reason) =>
            reason.startsWith('PERFORMANCE_VS_RANDOM') ||
            reason.startsWith('EVIDENCE_COMPLETENESS'),
        ),
      ).toBe(true)
    }
  })

  it('una sola partida fallida invalida la evidencia aunque las completadas superen los thresholds', () => {
    const decision = evaluatePromotionPolicyV1(
      input({
        candidateEvaluation: baseSummary({
          matchupSummary: [
            matchupRow('NEURAL_vs_RANDOM', 'NEURAL', 'RANDOM', 70, 100, { failures: 1 }),
            matchupRow('NEURAL_vs_RULE_BASED', 'NEURAL', 'RULE_BASED', 60, 100),
          ],
        }),
      }),
    )

    expect(decision.kind).toBe('FAIL')
    if (decision.kind === 'FAIL') {
      expect(decision.reasons.some((reason) => reason.includes('partidas fallidas'))).toBe(true)
    }
  })
})
