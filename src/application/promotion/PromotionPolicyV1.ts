import type {
  EvaluationSummary,
  MatchupSummaryRow,
} from '../../evaluation/experiment/EvaluationReport'

/**
 * `promotion-policy-v1` (EN-037.3, Management #572 §5): politica PURA,
 * tipada y versionada que decide si un candidato puede promoverse a
 * ACTIVE. NUNCA ejecuta el harness, NUNCA toca Mongo, NUNCA decide CUANDO
 * evaluar -- solo interpreta un `EvaluationSummary` YA producido por el
 * harness REAL de `#569` (`src/evaluation/experiment/EvaluationReport.ts`,
 * nunca reimplementado aqui).
 *
 * Decision del Product Owner (EN-037.3, Opcion B + ampliacion ratificada
 * sobre la linea base tecnica de Management #556/#572): la automatizacion
 * de la promocion fue aprobada, pero los thresholds de `#556/#572` (60%
 * Random / 45% RuleBased) se AMPLIAN aqui con dos cambios explicitos,
 * registrados como decision de producto, no como intuicion de
 * implementacion:
 *
 *   1. El umbral contra `RULE_BASED` sube de 45% a 50%: un candidato que
 *      pierde mas de la mitad de sus partidas contra la politica de
 *      referencia mas simple nunca deberia reemplazar al modelo vigente,
 *      aunque superase el 45% original.
 *   2. Gate NUEVO de no-regresion frente al ACTIVE vigente: ganar los
 *      gates absolutos no basta si el candidato juega PEOR que el modelo
 *      que ya esta en produccion -- "aprendizaje continuo" no debe
 *      significar "sustituir el modelo actual por cualquier candidato que
 *      alcance un minimo".
 *
 * Este modulo NUNCA evalua al ACTIVE vigente ejecutando un matchup nuevo
 * "Neural vs Neural-ACTIVE": el harness de `#569` solo expone UN slot
 * `NEURAL` por corrida (`PolicyComparisonHarnessDeps.neuralPolicy`), asi
 * que extenderlo para cargar dos artefactos ONNX simultaneos arriesgaria
 * tocar codigo ya revisado de `#569` sin necesidad. En su lugar, el
 * `AutomaticModelEvaluationCoordinator` (EN-037.3) invoca el MISMO harness
 * sin modificar DOS veces, con la MISMA configuracion determinista
 * (mismos seeds/matchups/escenarios): una vez con el artefacto del
 * candidato, otra con el artefacto del ACTIVE vigente -- y esta politica
 * compara los DOS `EvaluationSummary` resultantes sobre los MISMOS
 * matchups contra Random/RuleBased, nunca una partida candidato-vs-activo
 * directa.
 */
export const PROMOTION_POLICY_VERSION = 'promotion-policy-v1'

const NEURAL_VS_RANDOM_MATCHUP_ID = 'NEURAL_vs_RANDOM'
const NEURAL_VS_RULE_BASED_MATCHUP_ID = 'NEURAL_vs_RULE_BASED'
const REQUIRED_PROMOTION_MATCHUP_IDS = [
  NEURAL_VS_RANDOM_MATCHUP_ID,
  NEURAL_VS_RULE_BASED_MATCHUP_ID,
] as const

/** Linea base v1 (#556/#572) + ampliacion ratificada por el PO (ver docstring del modulo). */
export const PROMOTION_POLICY_V1_THRESHOLDS = {
  minWinRateVsRandom: 0.6,
  minWinRateVsRuleBased: 0.5,
} as const

export interface GateResult {
  readonly gate: string
  readonly passed: boolean
  readonly detail: string
}

export type PromotionDecision =
  | {
      readonly kind: 'PASS'
      readonly policyVersion: typeof PROMOTION_POLICY_VERSION
      readonly gates: readonly GateResult[]
    }
  | {
      readonly kind: 'FAIL'
      readonly policyVersion: typeof PROMOTION_POLICY_VERSION
      readonly gates: readonly GateResult[]
      readonly reasons: readonly string[]
    }

export interface PromotionPolicyInput {
  /** `EvaluationSummary` REAL de `#569` para el ARTEFACTO DEL CANDIDATO. */
  readonly candidateEvaluation: EvaluationSummary
  /**
   * `EvaluationSummary` REAL de `#569`, MISMA configuracion determinista,
   * para el ARTEFACTO DEL ACTIVE VIGENTE -- `null` solo cuando todavia no
   * existe ningun ACTIVE neuronal (primer modelo de la historia, #572
   * §5.1): en ese caso unico el gate de no-regresion se omite, nunca se
   * fuerza a FAIL por falta de un baseline que no puede existir.
   */
  readonly activeBaselineEvaluation: EvaluationSummary | null
}

const findMatchup = (
  summary: EvaluationSummary,
  matchupId: string,
): MatchupSummaryRow | undefined =>
  summary.matchupSummary.find((row) => row.matchupId === matchupId)

/**
 * `neuralWinRate = neuralWins / completedMatches` (#572 §5.5-5.6): el
 * NEURAL de los dos matchups obligatorios siempre es `firstPolicy`
 * (`REQUIRED_EVALUATION_MATCHUPS` en `EvaluationConfig.ts` fija
 * `['NEURAL', 'RANDOM']`/`['NEURAL', 'RULE_BASED']` en ese orden, nunca al
 * reves). `completedMatches = n - failures` (empates cuentan en el
 * denominador, nunca como victoria; partidas fallidas del harness NUNCA
 * entran al denominador, #572 §5.3). `null` si el matchup falta, esta
 * `SKIPPED_COST`, o no tiene ninguna partida completada -- nunca `0`
 * silencioso ni division por cero.
 */
const neuralWinRateOf = (summary: EvaluationSummary, matchupId: string): number | null => {
  const row = findMatchup(summary, matchupId)
  if (row === undefined || row.skippedForCost) return null
  const completedMatches = row.n - row.failures
  if (completedMatches <= 0) return null
  return row.firstPolicyWins / completedMatches
}

const isFiniteNumber = (value: number): boolean => Number.isFinite(value)

/**
 * Completitud/calidad de evidencia de UN `EvaluationSummary` (#572 §5.7):
 * `FULL_EVALUATION` (nunca `SMOKE_TEST`), modelo presente, los dos
 * matchups obligatorios presentes y con partidas completadas, metricas
 * finitas. Reutilizado tanto para el candidato como (si existe) para el
 * baseline ACTIVE -- las dos corridas deben ser igualmente completas para
 * que la comparacion sea valida.
 */
const evidenceCompletenessIssues = (
  summary: EvaluationSummary,
  label: string,
): readonly string[] => {
  const issues: string[] = []

  if (summary.evaluationPurpose !== 'FULL_EVALUATION') {
    issues.push(
      `${label}: evaluationPurpose="${summary.evaluationPurpose}", se exige FULL_EVALUATION.`,
    )
  }
  if (summary.model === null) {
    issues.push(`${label}: falta "model" (NeuralModelInfo) en el reporte.`)
  }
  if (
    !isFiniteNumber(summary.globalInvalidPolicySelections) ||
    !isFiniteNumber(summary.globalEngineRejections)
  ) {
    issues.push(
      `${label}: globalInvalidPolicySelections/globalEngineRejections no son numeros finitos.`,
    )
  }

  for (const matchupId of REQUIRED_PROMOTION_MATCHUP_IDS) {
    const row = findMatchup(summary, matchupId)
    if (row === undefined) {
      issues.push(`${label}: falta el matchup obligatorio "${matchupId}".`)
      continue
    }
    if (row.skippedForCost) {
      issues.push(`${label}: el matchup obligatorio "${matchupId}" esta SKIPPED_COST.`)
      continue
    }
    if (row.failures > 0) {
      issues.push(
        `${label}: el matchup "${matchupId}" contiene ${String(row.failures)} partidas fallidas; ` +
          'una evaluacion incompleta no puede promover.',
      )
    }
    if (row.n - row.failures <= 0) {
      issues.push(`${label}: el matchup "${matchupId}" no tiene ninguna partida completada.`)
    }
  }

  return issues
}

/** Gate de seguridad (#572 §5.3): 0 selecciones invalidas, 0 rechazos del motor, en TODO el reporte del candidato. */
const safetyGate = (candidate: EvaluationSummary): GateResult => {
  const passed =
    candidate.globalInvalidPolicySelections === 0 && candidate.globalEngineRejections === 0
  return {
    gate: 'SAFETY',
    passed,
    detail: passed
      ? '0 selecciones invalidas, 0 rechazos del motor.'
      : `${String(candidate.globalInvalidPolicySelections)} selecciones invalidas, ` +
        `${String(candidate.globalEngineRejections)} rechazos del motor (se exige 0 de cada uno).`,
  }
}

/** Gate de paridad PyTorch<->ONNX (#572 §5.4): reutiliza el `ParityReportSummary` REAL de `#569`, nunca recalculado aqui. */
const parityGate = (candidate: EvaluationSummary): GateResult => {
  const parity = candidate.parity
  const passed = parity?.passed === true
  return {
    gate: 'PARITY',
    passed,
    detail:
      parity === null
        ? 'El reporte no incluye validacion de paridad PyTorch<->ONNX.'
        : `paridad ${parity.passed ? 'PASS' : 'FAIL'} (argmaxAgreement=${String(parity.argmaxAgreement)}, ` +
          `maxAbsoluteError=${String(parity.maxAbsoluteError)}).`,
  }
}

const evidenceGate = (input: PromotionPolicyInput): GateResult => {
  const issues = [
    ...evidenceCompletenessIssues(input.candidateEvaluation, 'candidate'),
    ...(input.activeBaselineEvaluation === null
      ? []
      : evidenceCompletenessIssues(input.activeBaselineEvaluation, 'activeBaseline')),
  ]
  return {
    gate: 'EVIDENCE_COMPLETENESS',
    passed: issues.length === 0,
    detail: issues.length === 0 ? 'Evidencia completa.' : issues.join(' '),
  }
}

const performanceGate = (
  candidate: EvaluationSummary,
  matchupId: string,
  minWinRate: number,
  gateName: string,
): GateResult => {
  const winRate = neuralWinRateOf(candidate, matchupId)
  const passed = winRate !== null && winRate >= minWinRate
  return {
    gate: gateName,
    passed,
    detail:
      winRate === null
        ? `No se pudo calcular el win rate de "${matchupId}" (matchup ausente, SKIPPED_COST, o sin partidas completadas).`
        : `winRate=${(winRate * 100).toFixed(2)}% (se exige >= ${(minWinRate * 100).toFixed(2)}%).`,
  }
}

/**
 * Gate de no-regresion frente al ACTIVE vigente (#572 §5, ampliacion
 * ratificada por el PO): el candidato nunca debe jugar PEOR que el
 * modelo que ya esta en produccion sobre los MISMOS dos matchups
 * obligatorios, bajo la MISMA configuracion determinista. Vacuamente
 * `PASS` cuando todavia no existe ningun ACTIVE (primer modelo, #572
 * §5.1) -- nunca se exige superar a un baseline que no puede existir.
 *
 * Deliberadamente SIN tolerancia numerica (nunca `candidateRate >=
 * activeRate - X%`): el PO ratifico la comparacion "no inferior", no un
 * margen especifico, y `#572 §3` prohibe inventar un porcentaje de
 * tolerancia sin antes comprobar tamano de muestra -- eso queda
 * documentado como trabajo futuro, nunca como numero arbitrario aqui.
 */
const nonRegressionGate = (input: PromotionPolicyInput): GateResult => {
  if (input.activeBaselineEvaluation === null) {
    return {
      gate: 'NON_REGRESSION_VS_ACTIVE',
      passed: true,
      detail: 'No existe ningun ACTIVE vigente todavia: gate omitido (vacuously PASS).',
    }
  }

  const baseline = input.activeBaselineEvaluation
  if (
    baseline.fingerprints.evaluationConfigSha256 !==
    input.candidateEvaluation.fingerprints.evaluationConfigSha256
  ) {
    return {
      gate: 'NON_REGRESSION_VS_ACTIVE',
      passed: false,
      detail:
        'El reporte del ACTIVE vigente usa una evaluationConfigSha256 distinta a la del candidato: ' +
        'la comparacion no es reproducible/apples-to-apples, fail-closed.',
    }
  }

  const issues: string[] = []
  for (const matchupId of REQUIRED_PROMOTION_MATCHUP_IDS) {
    const candidateRate = neuralWinRateOf(input.candidateEvaluation, matchupId)
    const activeRate = neuralWinRateOf(baseline, matchupId)
    if (candidateRate === null || activeRate === null) {
      issues.push(
        `${matchupId}: no se pudo comparar (win rate indisponible en candidato o baseline).`,
      )
      continue
    }
    if (candidateRate < activeRate) {
      issues.push(
        `${matchupId}: el candidato (${(candidateRate * 100).toFixed(2)}%) es inferior al ACTIVE ` +
          `vigente (${(activeRate * 100).toFixed(2)}%).`,
      )
    }
  }

  return {
    gate: 'NON_REGRESSION_VS_ACTIVE',
    passed: issues.length === 0,
    detail:
      issues.length === 0 ? 'El candidato no es inferior al ACTIVE vigente.' : issues.join(' '),
  }
}

/**
 * Evalua TODOS los gates (nunca se detiene en el primero, #572 §20: el
 * reporte de gates debe ser completo, no parcial) y devuelve una decision
 * discriminada. `FAIL` nunca se confunde con una evaluacion invalida o
 * incompleta: `EVIDENCE_COMPLETENESS` es su propio gate, con su propio
 * mensaje, nunca un `PASS` disfrazado por falta de datos.
 */
export const evaluatePromotionPolicyV1 = (input: PromotionPolicyInput): PromotionDecision => {
  const gates: readonly GateResult[] = [
    evidenceGate(input),
    safetyGate(input.candidateEvaluation),
    parityGate(input.candidateEvaluation),
    performanceGate(
      input.candidateEvaluation,
      NEURAL_VS_RANDOM_MATCHUP_ID,
      PROMOTION_POLICY_V1_THRESHOLDS.minWinRateVsRandom,
      'PERFORMANCE_VS_RANDOM',
    ),
    performanceGate(
      input.candidateEvaluation,
      NEURAL_VS_RULE_BASED_MATCHUP_ID,
      PROMOTION_POLICY_V1_THRESHOLDS.minWinRateVsRuleBased,
      'PERFORMANCE_VS_RULE_BASED',
    ),
    nonRegressionGate(input),
  ]

  const failed = gates.filter((gate) => !gate.passed)
  if (failed.length === 0) {
    return { kind: 'PASS', policyVersion: PROMOTION_POLICY_VERSION, gates }
  }
  return {
    kind: 'FAIL',
    policyVersion: PROMOTION_POLICY_VERSION,
    gates,
    reasons: failed.map((gate) => `${gate.gate}: ${gate.detail}`),
  }
}
