import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClockPort } from '../../application/ports/ClockPort'
import type { AiModelArtifactRepositoryPort } from '../../application/ports/AiModelArtifactRepositoryPort'
import type {
  AiEvaluationCoordinatorPort,
  AiEvaluationLeaseClaim,
  AiEvaluationLedgerArtifactInfo,
  AiEvaluationLedgerSnapshot,
} from '../../application/ports/AiEvaluationCoordinatorPort'
import type { AiModelRegistry } from '../../application/services/AiModelRegistry'
import {
  evaluatePromotionPolicyV1,
  type GateResult,
} from '../../application/promotion/PromotionPolicyV1'
import { AiModelState } from '../../domain/value-objects/AiModelState'
import type { AiModelVersion } from '../../domain/entities/AiModelVersion'
import type { EvaluationSummary } from '../../evaluation/experiment/EvaluationReport'
import { materializeNeuralArtifactDir } from './NeuralArtifactMaterializer'
import { type RunAiEvaluationParams, type RunAiEvaluationResult } from './run-ai-evaluation'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'

/**
 * Orquestador tecnico de evaluacion automatica (EN-037.2 EN-037.3,
 * Management #572 §7): consume `CANDIDATE` del Model Registry (#570),
 * ejecuta el harness REAL de #569 dos veces con la MISMA configuracion
 * determinista (candidato, despues ACTIVE vigente -- nunca se extiende
 * `PolicyComparisonHarness` para un segundo slot `NEURAL` simultaneo, ver
 * docstring de `PromotionPolicyV1.ts`), aplica `promotion-policy-v1`, y
 * promueve o rechaza de forma segura y recuperable. NUNCA reimplementa el
 * harness, NUNCA decide gates por si mismo -- solo orquesta.
 */

export interface AutomaticModelEvaluationCoordinatorDeps {
  readonly registry: AiModelRegistry
  readonly ledger: AiEvaluationCoordinatorPort
  readonly artifactRepository: AiModelArtifactRepositoryPort
  readonly clock: ClockPort
  readonly logger: Logger
  /** Inyectable para pruebas: en produccion, `runAiEvaluation` de `run-ai-evaluation.ts` (#569), nunca reimplementado. */
  readonly runEvaluation: (params: RunAiEvaluationParams) => Promise<RunAiEvaluationResult>
}

export interface AutomaticModelEvaluationCoordinatorConfig {
  readonly ownerId: string
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly workRootDir: string
  readonly seedStart: number
  readonly seedCount: number
  readonly mctsSeedCount: number
  readonly maxPlies: number
  readonly sourceCommit: string
  readonly skipExpensiveMcts: boolean
}

export type AutomaticModelEvaluationOutcome =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'LEASE_BUSY' }
  | { readonly kind: 'PROMOTED'; readonly modelVersion: string }
  | {
      readonly kind: 'REJECTED'
      readonly modelVersion: string
      readonly reasons: readonly string[]
    }
  | {
      readonly kind: 'INFRASTRUCTURE_FAILURE'
      readonly modelVersion: string
      readonly reason: string
    }

/** Fallo TECNICO distinto de un fallo de gates (#572 §9): nunca se confunde con un `FAIL` de `PromotionPolicyV1`. */
export class EvaluationInfrastructureError extends Error {}

const artifactInfoOf = (version: AiModelVersion): AiEvaluationLedgerArtifactInfo => {
  const lineage = version.artifactLineage
  if (lineage === null) {
    throw new EvaluationInfrastructureError(
      `"${version.modelVersion}" no tiene artifactLineage (estado="${version.state}"), no se puede evaluar.`,
    )
  }
  if (lineage.parityReferenceSha256 === null) {
    throw new EvaluationInfrastructureError(
      `"${version.modelVersion}" no conserva parityReferenceSha256; no se puede evaluar sin inventar evidencia.`,
    )
  }
  return {
    trainingRunId: version.trainingLineage.trainingRunId,
    modelStateSha256: lineage.modelStateSha256,
    onnxArtifactSha256: lineage.onnxArtifactSha256,
    parityReferenceSha256: lineage.parityReferenceSha256,
  }
}

/** Reanuda un candidato cuya evaluacion YA quedo `DECIDED` en el ledger (#572 §13): nunca re-ejecuta el harness, solo termina la consecuencia pendiente. */
const resumeDecidedCandidate = async (
  deps: AutomaticModelEvaluationCoordinatorDeps,
  candidate: AiModelVersion,
  ledgerSnapshot: AiEvaluationLedgerSnapshot,
  claim: AiEvaluationLeaseClaim,
): Promise<AutomaticModelEvaluationOutcome> => {
  try {
    const at = deps.clock.now()

    if (ledgerSnapshot.evaluationOutcome === 'PASS') {
      await deps.ledger.markPromotionStatus(candidate.modelVersion, 'IN_PROGRESS', at)
      await deps.registry.promoteEvaluatedCandidate(candidate.modelVersion)
      await deps.ledger.markPromotionStatus(candidate.modelVersion, 'COMPLETED', at)
      deps.logger.info('ai_model_promoted', { modelVersion: candidate.modelVersion, resumed: true })
      return { kind: 'PROMOTED', modelVersion: candidate.modelVersion }
    }

    if (candidate.state === AiModelState.Evaluating) {
      await deps.registry.reject(
        candidate.modelVersion,
        'EVALUATION_FAILED',
        ledgerSnapshot.failureReasons.join(' | '),
      )
    }
    deps.logger.info('ai_candidate_rejected', {
      modelVersion: candidate.modelVersion,
      resumed: true,
    })
    return {
      kind: 'REJECTED',
      modelVersion: candidate.modelVersion,
      reasons: ledgerSnapshot.failureReasons,
    }
  } finally {
    await deps.ledger.releaseLease(claim, deps.clock.now())
  }
}

const evaluationParamsFor = (
  config: AutomaticModelEvaluationCoordinatorConfig,
  artifactDir: string,
  output: string,
): RunAiEvaluationParams => ({
  artifactDir,
  output,
  purpose: 'FULL_EVALUATION',
  seedStart: config.seedStart,
  seedCount: config.seedCount,
  mctsSeedCount: config.mctsSeedCount,
  maxPlies: config.maxPlies,
  sourceCommit: config.sourceCommit,
  skipExpensiveMcts: config.skipExpensiveMcts,
  // Nunca permitir un SMOKE_TEST en la evaluacion de promocion (#572 §5.7, GATE-10):
  // la evaluacion productiva jamas carga un artefacto marcado SMOKE_TEST.
  allowSmokeModel: false,
})

const runFreshEvaluation = async (
  deps: AutomaticModelEvaluationCoordinatorDeps,
  config: AutomaticModelEvaluationCoordinatorConfig,
  candidate: AiModelVersion,
  claim: AiEvaluationLeaseClaim,
): Promise<AutomaticModelEvaluationOutcome> => {
  const workDir = await mkdtemp(join(config.workRootDir, 'ai-evaluation-'))
  const heartbeatHandle = setInterval(() => {
    void deps.ledger.renewLease(claim, config.leaseDurationMs, deps.clock.now())
  }, config.heartbeatIntervalMs)

  try {
    const ownsEvaluation = await deps.ledger.markEvaluating(claim, deps.clock.now())
    if (!ownsEvaluation) {
      throw new EvaluationInfrastructureError('lease perdido antes de markEvaluating.')
    }

    const candidatePaths = await materializeNeuralArtifactDir(
      deps.artifactRepository,
      candidate,
      join(workDir, 'candidate'),
    )

    const activeBefore = await deps.registry.findActive()
    const previousActiveVersion =
      activeBefore !== null && activeBefore.modelVersion !== candidate.modelVersion
        ? activeBefore.modelVersion
        : null

    let activeBaselineEvaluation: EvaluationSummary | null = null
    if (activeBefore !== null && previousActiveVersion !== null) {
      const activePaths = await materializeNeuralArtifactDir(
        deps.artifactRepository,
        activeBefore,
        join(workDir, 'active-baseline'),
      )
      const activeResult = await deps.runEvaluation(
        evaluationParamsFor(config, activePaths.dir, join(workDir, 'active-baseline-output')),
      )
      activeBaselineEvaluation = activeResult.summary
    }

    const candidateResult = await deps.runEvaluation(
      evaluationParamsFor(config, candidatePaths.dir, join(workDir, 'candidate-output')),
    )

    const decision = evaluatePromotionPolicyV1({
      candidateEvaluation: candidateResult.summary,
      activeBaselineEvaluation,
    })

    const gateResults: readonly GateResult[] = decision.gates
    const failureReasons = decision.kind === 'FAIL' ? decision.reasons : []

    const recorded = await deps.ledger.recordDecision({
      claim,
      evaluationId: candidateResult.summary.evaluationId,
      evaluationOutcome: decision.kind,
      gateResults,
      failureReasons,
      previousActiveVersion,
      promotionPolicyVersion: decision.policyVersion,
      evaluationConfigVersion: candidateResult.summary.evaluationConfigVersion,
      sourceCommit: config.sourceCommit,
      seedSetSha256: candidateResult.summary.fingerprints.seedSetSha256,
      matchesSha256: candidateResult.summary.fingerprints.matchesSha256,
      evaluationConfigSha256: candidateResult.summary.fingerprints.evaluationConfigSha256,
      at: deps.clock.now(),
    })
    if (!recorded) {
      throw new EvaluationInfrastructureError('lease perdido antes de recordDecision.')
    }

    deps.logger.info('ai_promotion_policy_evaluated', {
      modelVersion: candidate.modelVersion,
      outcome: decision.kind,
      gates: JSON.stringify(gateResults),
    })

    if (decision.kind === 'PASS') {
      await deps.ledger.markPromotionStatus(candidate.modelVersion, 'IN_PROGRESS', deps.clock.now())
      await deps.registry.promoteEvaluatedCandidate(candidate.modelVersion)
      await deps.ledger.markPromotionStatus(candidate.modelVersion, 'COMPLETED', deps.clock.now())
      deps.logger.info('ai_model_promoted', { modelVersion: candidate.modelVersion })
      return { kind: 'PROMOTED', modelVersion: candidate.modelVersion }
    }

    await deps.registry.reject(
      candidate.modelVersion,
      'EVALUATION_FAILED',
      failureReasons.join(' | '),
    )
    deps.logger.info('ai_candidate_rejected', {
      modelVersion: candidate.modelVersion,
      reasons: failureReasons.join(' | '),
    })
    return { kind: 'REJECTED', modelVersion: candidate.modelVersion, reasons: failureReasons }
  } catch (error) {
    const reason = describeError(error)
    await deps.ledger.recordInfrastructureFailure(claim, reason, deps.clock.now())
    deps.logger.info('ai_evaluation_failed', { modelVersion: candidate.modelVersion, reason })
    return { kind: 'INFRASTRUCTURE_FAILURE', modelVersion: candidate.modelVersion, reason }
  } finally {
    clearInterval(heartbeatHandle)
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * UNA unidad de trabajo por llamada (mismo contrato que
 * `runContinuousTrainingIteration`, #571): descubre, reclama y procesa
 * como maximo UN candidato o UNA recuperacion. El CLI (`automatic-evaluation-worker.ts`)
 * la llama en bucle.
 */
export const processNextAutomaticEvaluation = async (
  deps: AutomaticModelEvaluationCoordinatorDeps,
  config: AutomaticModelEvaluationCoordinatorConfig,
): Promise<AutomaticModelEvaluationOutcome> => {
  const now = deps.clock.now()
  let sawAnyWork = false

  // 1. Recuperacion: candidatos ya `EVALUATING` cuyo trabajo quedo
  // interrumpido (o cuya decision ya se tomo pero no se aplico), #572 §13.
  const evaluatingVersions = await deps.registry.listByState(AiModelState.Evaluating)
  for (const candidate of evaluatingVersions) {
    sawAnyWork = true
    const ledgerSnapshot = await deps.ledger.getByModelVersion(candidate.modelVersion)
    if (ledgerSnapshot === null) continue // defensivo: no deberia ocurrir, el ledger se crea antes de beginEvaluation.

    const claim = await deps.ledger.ensureAndTryClaim(
      candidate.modelVersion,
      artifactInfoOf(candidate),
      config.ownerId,
      config.leaseDurationMs,
      now,
    )
    if (claim === null) continue // otro coordinador lo tiene vigente.
    if (ledgerSnapshot.status === 'DECIDED') {
      return resumeDecidedCandidate(deps, candidate, ledgerSnapshot, claim)
    }
    return runFreshEvaluation(deps, config, candidate, claim)
  }

  // 2. Trabajo nuevo: la CANDIDATE mas antigua todavia no reclamada.
  const candidates = await deps.registry.listByState(AiModelState.Candidate)
  for (const candidate of candidates) {
    sawAnyWork = true
    const claim = await deps.ledger.ensureAndTryClaim(
      candidate.modelVersion,
      artifactInfoOf(candidate),
      config.ownerId,
      config.leaseDurationMs,
      now,
    )
    if (claim === null) continue

    try {
      await deps.registry.beginEvaluation(candidate.modelVersion)
    } catch (error) {
      await deps.ledger.releaseLease(claim, now)
      deps.logger.info('ai_candidate_discovered', {
        modelVersion: candidate.modelVersion,
        claimed: false,
        reason: describeError(error),
      })
      continue
    }
    deps.logger.info('ai_evaluation_started', { modelVersion: candidate.modelVersion })
    return runFreshEvaluation(deps, config, candidate, claim)
  }

  return { kind: sawAnyWork ? 'LEASE_BUSY' : 'IDLE' }
}

export const defaultEvaluationWorkRootDir = (): string => tmpdir()
