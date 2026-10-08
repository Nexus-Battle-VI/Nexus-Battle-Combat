import { canonicalJsonSha256, canonicalJsonStringify, sha256Hex } from '../canonical/CanonicalJson'
import type { EvaluationMatchResultV1 } from '../battle/EvaluationMatchResult'
import type { EvaluationPolicyId } from '../policies/EvaluationPolicyId'
import type { EvaluationConfig } from './EvaluationConfig'
import type { EvaluationSide } from './EvaluationSeedSchedule'

export const EVALUATION_SUMMARY_SCHEMA_VERSION = 'evaluation-summary-v1'

export interface NeuralModelInfo {
  readonly modelArchitectureVersion: string
  readonly featureSchemaVersion: string
  readonly modelStateSha256: string
  readonly onnxArtifactSha256: string
  readonly artifactPurpose: string
}

export interface ParityReportSummary {
  readonly cases: number
  readonly scoresCompared: number
  readonly maxAbsoluteError: number
  readonly maxRelativeError: number
  readonly meanAbsoluteError: number
  readonly argmaxAgreement: number
  readonly atol: number
  readonly rtol: number
  readonly passed: boolean
}

/**
 * Orden ESTABLE y explicito (#569 §83): nunca orden de `Map`/filesystem, Y
 * nunca dependiente del orden de entrada -- `matchId` es el desempate
 * FINAL porque es unico por partida; sin el, dos partidas con el mismo
 * matchup/scenario/seed/leg (posible si el llamador repite una semilla)
 * quedarian ordenadas segun como llegaron al array, no segun su
 * contenido, rompiendo la reproducibilidad byte a byte del fingerprint.
 */
export const sortMatchResults = (
  results: readonly EvaluationMatchResultV1[],
): readonly EvaluationMatchResultV1[] =>
  [...results].sort((a, b) => {
    if (a.matchupId !== b.matchupId) return a.matchupId.localeCompare(b.matchupId)
    if (a.scenarioId !== b.scenarioId) return a.scenarioId.localeCompare(b.scenarioId)
    if (a.matchSeed !== b.matchSeed) return a.matchSeed - b.matchSeed
    if (a.mirrorLeg !== b.mirrorLeg) return a.mirrorLeg.localeCompare(b.mirrorLeg)
    return a.matchId.localeCompare(b.matchId)
  })

export const buildMatchesJsonl = (results: readonly EvaluationMatchResultV1[]): string =>
  sortMatchResults(results)
    .map((result) => canonicalJsonStringify(result))
    .join('\n') + '\n'

export const matchesSha256Of = (results: readonly EvaluationMatchResultV1[]): string =>
  sha256Hex(
    sortMatchResults(results)
      .map((result) => canonicalJsonStringify(result))
      .join('\n'),
  )

/** `null` cuando no hay datos (#569 §176: nunca `NaN`/`Infinity`). */
const average = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

interface PolicyAccumulator {
  battles: number
  /** Partidas con `status === 'COMPLETED'` en las que aparecio esta politica (#569 corregido en revision: denominador EXPLICITO, nunca `battles - failures`). */
  completedBattles: number
  wins: number
  losses: number
  draws: number
  /** Apariciones en partidas NO `COMPLETED`, de cualquier causa (propia o del rival). */
  failures: number
  /** De esas, cuantas causo la politica de ESTE lado (`failedSide === side`). */
  failuresCaused: number
  damage: number[]
  healthRatio: number[]
  power: number[]
  plies: number[]
  turnsCompleted: number[]
}

const newAccumulator = (): PolicyAccumulator => ({
  battles: 0,
  completedBattles: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  failures: 0,
  failuresCaused: 0,
  damage: [],
  healthRatio: [],
  power: [],
  plies: [],
  turnsCompleted: [],
})

export interface PolicySummaryRow {
  readonly policyId: EvaluationPolicyId
  readonly battles: number
  readonly completedBattles: number
  readonly wins: number
  readonly losses: number
  readonly draws: number
  readonly failures: number
  readonly failuresCaused: number
  /**
   * `wins / completedBattles` (#569 §47, §176; corregido en revision: una
   * partida abortada por el RIVAL nunca entra al denominador de NINGUNA
   * de las dos politicas -- antes se deducia `battles - failures` y esa
   * resta solo restaba las fallas CAUSADAS por este lado, contando la
   * partida como "completada" para el lado inocente). `null` si
   * `completedBattles === 0`.
   */
  readonly winRate: number | null
  readonly avgDamageDealt: number | null
  readonly avgHealthRemainingRatio: number | null
  readonly avgPowerRemaining: number | null
  readonly avgPlies: number | null
  readonly avgTurnsCompleted: number | null
}

export interface MatchupScenarioRow {
  readonly scenarioId: string
  readonly n: number
  readonly firstPolicyWins: number
  readonly secondPolicyWins: number
  readonly draws: number
  readonly failures: number
}

export interface MatchupSummaryRow {
  readonly matchupId: string
  readonly firstPolicy: EvaluationPolicyId
  readonly secondPolicy: EvaluationPolicyId
  readonly n: number
  readonly firstPolicyWins: number
  readonly secondPolicyWins: number
  readonly draws: number
  readonly failures: number
  readonly skippedForCost: boolean
  readonly byScenario: readonly MatchupScenarioRow[]
}

const sideWinner = (
  result: EvaluationMatchResultV1,
): { readonly policyId: EvaluationPolicyId; readonly side: EvaluationSide } | null => {
  // `== null`: cubre tanto "sin outcome" (`result.outcome` null) como
  // "outcome sin ganador" (`winnerSide` null), sin perder la distincion
  // real con `undefined` en ningun otro punto del tipo.
  if (result.status !== 'COMPLETED' || result.outcome?.winnerSide == null) {
    return null
  }
  const side = result.outcome.winnerSide
  return { policyId: side === 'A' ? result.policyA : result.policyB, side }
}

const buildPolicySummary = (
  results: readonly EvaluationMatchResultV1[],
): readonly PolicySummaryRow[] => {
  const accumulators = new Map<EvaluationPolicyId, PolicyAccumulator>()
  const accumulatorFor = (policyId: EvaluationPolicyId): PolicyAccumulator => {
    const existing = accumulators.get(policyId)
    if (existing !== undefined) return existing
    const created = newAccumulator()
    accumulators.set(policyId, created)
    return created
  }

  for (const result of results) {
    for (const side of ['A', 'B'] as const) {
      const policyId = side === 'A' ? result.policyA : result.policyB
      const accumulator = accumulatorFor(policyId)
      accumulator.battles += 1

      // `battles - failures` como denominador de winRate estaba mal: una
      // partida abortada por el RIVAL nunca incrementaba `failures` para
      // ESTE lado, asi que `completed` la contaba de todas formas. Ahora
      // `failures` cuenta CUALQUIER aparicion no-COMPLETED (de cualquier
      // causa) y `completedBattles` es un contador EXPLICITO, nunca
      // deducido.
      if (result.status !== 'COMPLETED') {
        accumulator.failures += 1
        if (result.failedSide === side) {
          accumulator.failuresCaused += 1
        }
        continue
      }

      accumulator.completedBattles += 1
      const metrics = result.metricsBySide[side]
      accumulator.damage.push(metrics.damageDealt)
      if (metrics.finalHealth !== null)
        accumulator.healthRatio.push(metrics.finalHealth.lifePercent)
      if (metrics.finalPower !== null) accumulator.power.push(metrics.finalPower)
      accumulator.plies.push(result.plies)
      accumulator.turnsCompleted.push(result.turnsCompleted)

      const winner = sideWinner(result)
      if (winner === null) {
        accumulator.draws += 1
      } else if (winner.side === side) {
        accumulator.wins += 1
      } else {
        accumulator.losses += 1
      }
    }
  }

  return [...accumulators.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([policyId, accumulator]) => ({
      policyId,
      battles: accumulator.battles,
      completedBattles: accumulator.completedBattles,
      wins: accumulator.wins,
      losses: accumulator.losses,
      draws: accumulator.draws,
      failures: accumulator.failures,
      failuresCaused: accumulator.failuresCaused,
      winRate:
        accumulator.completedBattles > 0 ? accumulator.wins / accumulator.completedBattles : null,
      avgDamageDealt: average(accumulator.damage),
      avgHealthRemainingRatio: average(accumulator.healthRatio),
      avgPowerRemaining: average(accumulator.power),
      avgPlies: average(accumulator.plies),
      avgTurnsCompleted: average(accumulator.turnsCompleted),
    }))
}

const buildMatchupSummary = (
  config: EvaluationConfig,
  results: readonly EvaluationMatchResultV1[],
): readonly MatchupSummaryRow[] =>
  config.matchups.map((matchup) => {
    const matchupIdValue = `${matchup[0]}_vs_${matchup[1]}`
    const relevant = results.filter((result) => result.matchupId === matchupIdValue)
    const scenarioIds = [...new Set(relevant.map((result) => result.scenarioId))].sort((a, b) =>
      a.localeCompare(b),
    )

    const tally = (subset: readonly EvaluationMatchResultV1[]) => {
      let firstPolicyWins = 0
      let secondPolicyWins = 0
      let draws = 0
      let failures = 0

      for (const result of subset) {
        if (result.status !== 'COMPLETED') {
          failures += 1
          continue
        }
        const winner = sideWinner(result)
        if (winner === null) draws += 1
        else if (winner.policyId === matchup[0]) firstPolicyWins += 1
        else secondPolicyWins += 1
      }

      return { n: subset.length, firstPolicyWins, secondPolicyWins, draws, failures }
    }

    const overall = tally(relevant)

    return {
      matchupId: matchupIdValue,
      firstPolicy: matchup[0],
      secondPolicy: matchup[1],
      ...overall,
      skippedForCost: relevant.length === 0,
      byScenario: scenarioIds.map((scenarioId) => ({
        scenarioId,
        ...tally(relevant.filter((result) => result.scenarioId === scenarioId)),
      })),
    }
  })

export interface EvaluationSummary {
  readonly summarySchemaVersion: typeof EVALUATION_SUMMARY_SCHEMA_VERSION
  readonly evaluationId: string
  readonly evaluationPurpose: EvaluationConfig['purpose']
  readonly evaluationConfigVersion: string
  readonly scenarioVersion: string
  readonly sourceCommit: string
  readonly model: NeuralModelInfo | null
  readonly parity: ParityReportSummary | null
  readonly totalMatches: number
  readonly totalMirrorPairs: number
  readonly globalInvalidPolicySelections: number
  readonly globalEngineRejections: number
  readonly policySummary: readonly PolicySummaryRow[]
  readonly matchupSummary: readonly MatchupSummaryRow[]
  readonly fingerprints: {
    readonly evaluationConfigSha256: string
    readonly seedSetSha256: string
    readonly matchesSha256: string
  }
}

export const buildEvaluationSummary = (params: {
  readonly evaluationId: string
  readonly config: EvaluationConfig
  readonly results: readonly EvaluationMatchResultV1[]
  readonly model: NeuralModelInfo | null
  readonly parity: ParityReportSummary | null
}): EvaluationSummary => {
  const { evaluationId, config, results, model, parity } = params
  const mirrorPairIds = new Set(results.map((result) => result.mirrorPairId))
  const seedSet = [...new Set(results.map((result) => result.matchSeed))].sort((a, b) => a - b)

  return {
    summarySchemaVersion: EVALUATION_SUMMARY_SCHEMA_VERSION,
    evaluationId,
    evaluationPurpose: config.purpose,
    evaluationConfigVersion: config.configVersion,
    scenarioVersion: 'evaluation-scenarios-v1',
    sourceCommit: config.sourceCommit,
    model,
    parity,
    totalMatches: results.length,
    totalMirrorPairs: mirrorPairIds.size,
    globalInvalidPolicySelections: results.reduce((sum, r) => sum + r.invalidPolicySelections, 0),
    globalEngineRejections: results.reduce((sum, r) => sum + r.engineRejections, 0),
    policySummary: buildPolicySummary(results),
    matchupSummary: buildMatchupSummary(config, results),
    fingerprints: {
      evaluationConfigSha256: canonicalJsonSha256(config),
      seedSetSha256: canonicalJsonSha256(seedSet),
      matchesSha256: matchesSha256Of(results),
    },
  }
}

const pct = (ratio: number | null): string =>
  ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`
const num = (value: number | null, digits = 2): string =>
  value === null ? '—' : value.toFixed(digits)

export const buildEvaluationSummaryMarkdown = (summary: EvaluationSummary): string => {
  const lines: string[] = []

  lines.push(`# Reporte de evaluacion de politicas de IA (${summary.evaluationId})`)
  lines.push('')

  if (summary.model !== null && summary.model.artifactPurpose === 'SMOKE_TEST') {
    lines.push('> **MODEL PURPOSE: SMOKE_TEST**')
    lines.push('>')
    lines.push(
      '> Este modelo fue entrenado con datos sinteticos de smoke. Las metricas de Neural en ' +
        'este reporte NO constituyen evidencia para promocion productiva.',
    )
    lines.push('')
  }

  lines.push(
    `Purpose: **${summary.evaluationPurpose}** · sourceCommit: \`${summary.sourceCommit}\``,
  )
  lines.push('')
  lines.push(
    `Total partidas: ${String(summary.totalMatches)} · Pares espejados: ${String(summary.totalMirrorPairs)}`,
  )
  lines.push(
    `Selecciones invalidas (global): ${String(summary.globalInvalidPolicySelections)} · ` +
      `Rechazos del motor (global): ${String(summary.globalEngineRejections)}`,
  )
  lines.push('')

  if (summary.parity !== null) {
    lines.push('## Paridad PyTorch <-> ONNX')
    lines.push('')
    lines.push(`Resultado: **${summary.parity.passed ? 'PASS' : 'FAIL'}**`)
    lines.push(
      `Casos: ${String(summary.parity.cases)} · Scores comparados: ${String(summary.parity.scoresCompared)} · ` +
        `argmax agreement: ${pct(summary.parity.argmaxAgreement)}`,
    )
    lines.push(
      `maxAbsoluteError: ${num(summary.parity.maxAbsoluteError, 8)} (atol=${num(summary.parity.atol, 8)}) · ` +
        `maxRelativeError: ${num(summary.parity.maxRelativeError, 8)} (rtol=${num(summary.parity.rtol, 8)})`,
    )
    lines.push('')
  }

  lines.push('## Por politica')
  lines.push('')
  lines.push(
    '| Policy | Battles | Completed | Wins | Losses | Draws | Failures | Win rate | Damage | Health remaining | Power remaining | Avg turns | Avg plies |',
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of summary.policySummary) {
    lines.push(
      `| ${row.policyId} | ${String(row.battles)} | ${String(row.completedBattles)} | ` +
        `${String(row.wins)} | ${String(row.losses)} | ${String(row.draws)} | ` +
        `${String(row.failures)} | ${pct(row.winRate)} | ${num(row.avgDamageDealt)} | ` +
        `${pct(row.avgHealthRemainingRatio)} | ${num(row.avgPowerRemaining)} | ` +
        `${num(row.avgTurnsCompleted, 1)} | ${num(row.avgPlies, 1)} |`,
    )
  }
  lines.push('')
  lines.push(
    '_"Avg turns" = `BattleState.turnsCompleted` real; "Avg plies" = pasos del harness ' +
      '(incluye `SYSTEM_END_TURN`) -- nunca el mismo numero (#569 §54)._',
  )
  lines.push('')

  lines.push('## Por matchup')
  lines.push('')
  lines.push('| Matchup | N | P1 wins | P2 wins | Draws | Failures |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const row of summary.matchupSummary) {
    if (row.skippedForCost) {
      lines.push(`| ${row.matchupId} | 0 | — | — | — | SKIPPED_COST |`)
      continue
    }
    lines.push(
      `| ${row.matchupId} | ${String(row.n)} | ${String(row.firstPolicyWins)} | ` +
        `${String(row.secondPolicyWins)} | ${String(row.draws)} | ${String(row.failures)} |`,
    )
  }
  lines.push('')

  lines.push('### Por matchup y escenario')
  lines.push('')
  for (const row of summary.matchupSummary) {
    if (row.skippedForCost) continue
    lines.push(`**${row.matchupId}**`)
    lines.push('')
    lines.push('| Scenario | N | P1 wins | P2 wins | Draws | Failures |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const scenarioRow of row.byScenario) {
      lines.push(
        `| ${scenarioRow.scenarioId} | ${String(scenarioRow.n)} | ${String(scenarioRow.firstPolicyWins)} | ` +
          `${String(scenarioRow.secondPolicyWins)} | ${String(scenarioRow.draws)} | ` +
          `${String(scenarioRow.failures)} |`,
      )
    }
    lines.push('')
  }

  lines.push('## Fingerprints de reproducibilidad')
  lines.push('')
  lines.push(`- evaluationConfigSha256: \`${summary.fingerprints.evaluationConfigSha256}\``)
  lines.push(`- seedSetSha256: \`${summary.fingerprints.seedSetSha256}\``)
  lines.push(`- matchesSha256: \`${summary.fingerprints.matchesSha256}\``)
  lines.push('')
  lines.push(
    '_Este reporte mide y compara; no decide promocion. Ver `docs/en-036-ai-evaluation.md` para ' +
      'que SI y que NO demuestra esta evaluacion._',
  )

  return lines.join('\n') + '\n'
}
