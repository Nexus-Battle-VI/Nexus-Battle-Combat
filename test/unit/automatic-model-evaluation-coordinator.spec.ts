import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  processNextAutomaticEvaluation,
  type AutomaticModelEvaluationCoordinatorConfig,
  type AutomaticModelEvaluationCoordinatorDeps,
} from '../../src/infrastructure/evaluation/AutomaticModelEvaluationCoordinator'
import type {
  RunAiEvaluationParams,
  RunAiEvaluationResult,
} from '../../src/infrastructure/evaluation/run-ai-evaluation'
import {
  AiModelRegistry,
  type CandidateArtifactManifest,
} from '../../src/application/services/AiModelRegistry'
import { InMemoryAiModelRegistryRepository } from '../../src/adapters/outbound/persistence/InMemoryAiModelRegistryRepository'
import { InMemoryAiModelArtifactRepository } from '../../src/adapters/outbound/persistence/InMemoryAiModelArtifactRepository'
import { InMemoryAiEvaluationCoordinatorRepository } from '../../src/adapters/outbound/persistence/InMemoryAiEvaluationCoordinatorRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { AiEvaluationCoordinatorPort } from '../../src/application/ports/AiEvaluationCoordinatorPort'
import type { Logger } from '../../src/infrastructure/observability/logger'
import type { AiModelTrainingLineage } from '../../src/domain/entities/AiModelVersion'
import type {
  EvaluationSummary,
  MatchupSummaryRow,
  NeuralModelInfo,
  ParityReportSummary,
} from '../../src/evaluation/experiment/EvaluationReport'

const hex = (digit: string): string => digit.repeat(64)
let AT = new Date('2027-03-01T00:00:00.000Z')
const fixedClock = (): ClockPort => ({ now: () => AT })
const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const onnxBytesFor = (seed: string): Buffer => Buffer.from(`fake-onnx-${seed}`)
const metricsBytes = Buffer.from('{"winRate":null}')
const manifestBytesFor = (seed: string): Buffer => Buffer.from(`{"fake-manifest":"${seed}"}`)
const parityReferenceBytesFor = (seed: string): Buffer => Buffer.from(`{"fake-parity":"${seed}"}`)

const FIXED_TRAINING_FIELDS = {
  modelArchitectureVersion: 'candidate-mlp-v1',
  featureSchemaVersion: 'feature-schema-v1',
  teacherVersion: 'mcts-teacher-v1',
  utilityVersion: 'pve-utility-v1',
  trainingSourceCommit: 'a1b2c3',
  datasetSourceCommit: 'd4e5f6',
  datasetInputFingerprint: hex('1'),
  datasetOutputFingerprint: hex('2'),
  datasetCutoff: '2027-01-01T00:00:00Z',
  datasetSeed: 42,
  trainingConfigSha256: hex('3'),
  trainingSeed: 7,
}

const trainingLineage = (modelVersion: string): AiModelTrainingLineage => ({
  modelVersion,
  trainingRunId: modelVersion,
  ...FIXED_TRAINING_FIELDS,
})

/** Registra una CANDIDATE real (mismo patron que `ai-model-registry.spec.ts`), con bytes propios por `seed` para poder distinguir artefactos en el fake harness. */
const registerCandidate = async (
  registry: AiModelRegistry,
  modelVersion: string,
  seed: string,
): Promise<void> => {
  await registry.startTraining(trainingLineage(modelVersion))
  const onnxBytes = onnxBytesFor(seed)
  const manifestBytes = manifestBytesFor(seed)
  const parityReferenceBytes = parityReferenceBytesFor(seed)
  const manifest: CandidateArtifactManifest = {
    ...FIXED_TRAINING_FIELDS,
    trainingConfig: { trainingSeed: FIXED_TRAINING_FIELDS.trainingSeed },
    datasetCounts: { battles: 4 },
    modelStateSha256: hex('4'),
    onnxArtifactSha256: createHash('sha256').update(onnxBytes).digest('hex'),
    pytorchArtifactSha256: hex('6'),
    metricsFileSha256: createHash('sha256').update(metricsBytes).digest('hex'),
    parityReferenceSha256: createHash('sha256').update(parityReferenceBytes).digest('hex'),
    artifactPurpose: 'CANDIDATE',
  }
  await registry.registerCandidate({
    modelVersion,
    manifest,
    manifestBytes,
    onnxBytes,
    metricsBytes,
    parityReferenceBytes,
  })
}

const model: NeuralModelInfo = {
  modelArchitectureVersion: 'candidate-mlp-v1',
  featureSchemaVersion: 'feature-schema-v1',
  modelStateSha256: hex('4'),
  onnxArtifactSha256: hex('5'),
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
const matchupRow = (
  matchupId: string,
  wins: number,
  n: number,
  overrides: Partial<MatchupSummaryRow> = {},
): MatchupSummaryRow => ({
  matchupId,
  firstPolicy: 'NEURAL',
  secondPolicy: matchupId === 'NEURAL_vs_RANDOM' ? 'RANDOM' : 'RULE_BASED',
  n,
  firstPolicyWins: wins,
  secondPolicyWins: n - wins,
  draws: 0,
  failures: 0,
  skippedForCost: false,
  byScenario: [],
  ...overrides,
})

let evaluationCounter = 0
const summaryFor = (
  winRateRandom: number,
  winRateRuleBased: number,
  configSha256: string,
): EvaluationSummary => {
  evaluationCounter += 1
  return {
    summarySchemaVersion: 'evaluation-summary-v1',
    evaluationId: `eval-${String(evaluationCounter)}`,
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
      matchupRow('NEURAL_vs_RANDOM', Math.round(winRateRandom * 100), 100),
      matchupRow('NEURAL_vs_RULE_BASED', Math.round(winRateRuleBased * 100), 100),
    ],
    fingerprints: {
      evaluationProtocolSha256: configSha256,
      evaluationConfigSha256: configSha256,
      seedSetSha256: hex('a'),
      matchesSha256: hex('b'),
    },
  }
}

interface FakeHarnessFixture {
  readonly candidate: EvaluationSummary
  readonly activeBaseline?: EvaluationSummary
  readonly failing?: boolean
}

const fakeRunEvaluation =
  (fixture: FakeHarnessFixture) =>
  (params: RunAiEvaluationParams): Promise<RunAiEvaluationResult> => {
    if (fixture.failing === true) return Promise.reject(new Error('fake harness crash'))
    const isBaseline = params.artifactDir.includes('active-baseline')
    const summary = isBaseline ? fixture.activeBaseline! : fixture.candidate
    return Promise.resolve({ summary, parityReport: summary.parity! })
  }

describe('AutomaticModelEvaluationCoordinator (EN-037.3, Management #572 §7, §14-B)', () => {
  let workRootDir: string

  beforeEach(async () => {
    AT = new Date('2027-03-01T00:00:00.000Z')
    evaluationCounter = 0
    workRootDir = await mkdtemp(join(tmpdir(), 'ai-evaluation-coordinator-test-'))
  })

  afterEach(async () => {
    await rm(workRootDir, { recursive: true, force: true })
  })

  const newDeps = (
    fixture: FakeHarnessFixture,
  ): { deps: AutomaticModelEvaluationCoordinatorDeps; registry: AiModelRegistry } => {
    const artifactRepository = new InMemoryAiModelArtifactRepository()
    const registry = new AiModelRegistry(
      new InMemoryAiModelRegistryRepository(),
      artifactRepository,
      fixedClock(),
    )
    const deps: AutomaticModelEvaluationCoordinatorDeps = {
      registry,
      ledger: new InMemoryAiEvaluationCoordinatorRepository(),
      artifactRepository,
      clock: fixedClock(),
      logger: noopLogger,
      runEvaluation: fakeRunEvaluation(fixture),
    }
    return { deps, registry }
  }

  const baseConfig = (): AutomaticModelEvaluationCoordinatorConfig => ({
    ownerId: 'coordinator-1',
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 10_000,
    workRootDir,
    seedStart: 1,
    seedCount: 10,
    mctsSeedCount: 2,
    maxPlies: 200,
    sourceCommit: 'abc123',
    skipExpensiveMcts: true,
  })

  it('EV-01/EV-09: discovers a fresh CANDIDATE and promotes it automatically on PASS, no human step', async () => {
    const { deps, registry } = newDeps({ candidate: summaryFor(0.7, 0.55, hex('c')) })
    await registerCandidate(registry, 'm-1', 'seed-1')

    const outcome = await processNextAutomaticEvaluation(deps, baseConfig())
    expect(outcome).toEqual({ kind: 'PROMOTED', modelVersion: 'm-1' })

    const active = await registry.findActive()
    expect(active?.modelVersion).toBe('m-1')
  })

  it('EV-03/EV-04: evaluates the exact candidate artifact and persists a reproducible ledger entry', async () => {
    const summary = summaryFor(0.7, 0.55, hex('c'))
    const { deps, registry } = newDeps({ candidate: summary })
    await registerCandidate(registry, 'm-1', 'seed-1')

    await processNextAutomaticEvaluation(deps, baseConfig())

    const ledgerSnapshot = await deps.ledger.getByModelVersion('m-1')
    expect(ledgerSnapshot?.status).toBe('DECIDED')
    expect(ledgerSnapshot?.evaluationOutcome).toBe('PASS')
    expect(ledgerSnapshot?.matchesSha256).toBe(summary.fingerprints.matchesSha256)
    expect(ledgerSnapshot?.candidateSummarySha256).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      deps.artifactRepository.getBySha256(ledgerSnapshot!.candidateSummarySha256!),
    ).resolves.not.toBeNull()
    expect(ledgerSnapshot?.promotionPolicyVersion).toBe('promotion-policy-v1')
  })

  it('EV-10: a definitive FAIL rejects the candidate and conserves the previous ACTIVE', async () => {
    // Primero: m-0 se promueve (sin ACTIVE previo, gate de no-regresion vacuo).
    const { deps, registry } = newDeps({ candidate: summaryFor(0.65, 0.55, hex('c')) })
    await registerCandidate(registry, 'm-0', 'seed-0')
    await processNextAutomaticEvaluation(deps, baseConfig())
    expect((await registry.findActive())?.modelVersion).toBe('m-0')

    // Ahora: m-1 falla el gate de performance (sube el win rate de RuleBased por debajo del 50%).
    const failingDeps: AutomaticModelEvaluationCoordinatorDeps = {
      ...deps,
      runEvaluation: fakeRunEvaluation({
        candidate: summaryFor(0.7, 0.3, hex('c')),
        activeBaseline: summaryFor(0.65, 0.55, hex('c')),
      }),
    }
    await registerCandidate(registry, 'm-1', 'seed-1')
    const outcome = await processNextAutomaticEvaluation(failingDeps, baseConfig())

    expect(outcome.kind).toBe('REJECTED')
    const rejected = await registry.findByVersion('m-1')
    expect(rejected?.state).toBe('REJECTED')

    const activeAfter = await registry.findActive()
    expect(activeAfter?.modelVersion).toBe('m-0')
  })

  it('paridad medida FAIL rechaza definitivamente; nunca se clasifica como infraestructura', async () => {
    const summary = summaryFor(0.7, 0.55, hex('c'))
    const { deps, registry } = newDeps({
      candidate: { ...summary, parity: { ...passingParity, passed: false } },
    })
    await registerCandidate(registry, 'm-parity-fail', 'seed-parity')
    const outcome = await processNextAutomaticEvaluation(deps, baseConfig())
    expect(outcome.kind).toBe('REJECTED')
    expect((await registry.findByVersion('m-parity-fail'))?.state).toBe('REJECTED')
  })

  it('promotion replaces the previous ACTIVE: old becomes SUPERSEDED, new becomes ACTIVE', async () => {
    const { deps, registry } = newDeps({ candidate: summaryFor(0.65, 0.55, hex('c')) })
    await registerCandidate(registry, 'm-0', 'seed-0')
    await processNextAutomaticEvaluation(deps, baseConfig())

    const betterDeps: AutomaticModelEvaluationCoordinatorDeps = {
      ...deps,
      runEvaluation: fakeRunEvaluation({
        candidate: summaryFor(0.7, 0.6, hex('c')),
        activeBaseline: summaryFor(0.65, 0.55, hex('c')),
      }),
    }
    await registerCandidate(registry, 'm-1', 'seed-1')
    const outcome = await processNextAutomaticEvaluation(betterDeps, baseConfig())
    expect(outcome).toEqual({ kind: 'PROMOTED', modelVersion: 'm-1' })

    const m0 = await registry.findByVersion('m-0')
    expect(m0?.state).toBe('SUPERSEDED')
    const m1 = await registry.findByVersion('m-1')
    expect(m1?.state).toBe('ACTIVE')
  })

  it('EV-08: a transient harness crash never becomes REJECTED, candidate stays recoverable in EVALUATING', async () => {
    const { deps, registry } = newDeps({
      candidate: summaryFor(0.7, 0.55, hex('c')),
      failing: true,
    })
    await registerCandidate(registry, 'm-1', 'seed-1')

    const outcome = await processNextAutomaticEvaluation(deps, baseConfig())
    expect(outcome.kind).toBe('INFRASTRUCTURE_FAILURE')

    const candidate = await registry.findByVersion('m-1')
    expect(candidate?.state).toBe('EVALUATING')

    const ledgerSnapshot = await deps.ledger.getByModelVersion('m-1')
    expect(ledgerSnapshot?.evaluationOutcome).toBeNull()
    expect(ledgerSnapshot?.consecutiveFailureCount).toBe(1)
  })

  it('EV-06: recovers an abandoned EVALUATING candidate after a simulated restart and completes it', async () => {
    const crashingDeps = newDeps({ candidate: summaryFor(0.7, 0.55, hex('c')), failing: true })
    await registerCandidate(crashingDeps.registry, 'm-1', 'seed-1')
    const crashOutcome = await processNextAutomaticEvaluation(crashingDeps.deps, baseConfig())
    expect(crashOutcome.kind).toBe('INFRASTRUCTURE_FAILURE')

    // "Reinicio": un deps nuevo con el MISMO registry/ledger (simula un proceso nuevo), harness ya sano.
    const recoveredDeps: AutomaticModelEvaluationCoordinatorDeps = {
      ...crashingDeps.deps,
      runEvaluation: fakeRunEvaluation({ candidate: summaryFor(0.7, 0.55, hex('c')) }),
    }
    const outcome = await processNextAutomaticEvaluation(recoveredDeps, baseConfig())
    expect(outcome).toEqual({ kind: 'PROMOTED', modelVersion: 'm-1' })
  })

  it('EV-05: two coordinators cannot evaluate the same candidate concurrently', async () => {
    const summary = summaryFor(0.7, 0.55, hex('c'))
    const fixture = newDeps({ candidate: summary })
    await registerCandidate(fixture.registry, 'm-1', 'seed-1')
    let releaseHarness: (() => void) | undefined
    const runEvaluation = jest.fn(
      () =>
        new Promise<RunAiEvaluationResult>((resolve) => {
          releaseHarness = () => {
            resolve({ summary, parityReport: summary.parity! })
          }
        }),
    )
    const firstDeps = { ...fixture.deps, runEvaluation }

    const first = processNextAutomaticEvaluation(firstDeps, baseConfig())
    while (runEvaluation.mock.calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const second = await processNextAutomaticEvaluation(firstDeps, {
      ...baseConfig(),
      ownerId: 'coordinator-2',
    })

    expect(second).toEqual({ kind: 'LEASE_BUSY' })
    expect(runEvaluation).toHaveBeenCalledTimes(1)
    releaseHarness?.()
    await expect(first).resolves.toEqual({ kind: 'PROMOTED', modelVersion: 'm-1' })
  })

  it('EV-07: a stale owner that loses fencing before markEvaluating never runs the harness', async () => {
    const fixture = newDeps({ candidate: summaryFor(0.7, 0.55, hex('c')) })
    await registerCandidate(fixture.registry, 'm-1', 'seed-1')
    const runEvaluation = jest.fn(fakeRunEvaluation({ candidate: summaryFor(0.7, 0.55, hex('c')) }))
    const staleLedger = Object.create(fixture.deps.ledger) as AiEvaluationCoordinatorPort
    staleLedger.markEvaluating = jest.fn().mockResolvedValue(false)

    const outcome = await processNextAutomaticEvaluation(
      { ...fixture.deps, ledger: staleLedger, runEvaluation },
      baseConfig(),
    )

    expect(outcome.kind).toBe('INFRASTRUCTURE_FAILURE')
    expect(runEvaluation).not.toHaveBeenCalled()
  })

  it('no existing ACTIVE: the non-regression gate is vacuously satisfied for the first model ever', async () => {
    const { deps, registry } = newDeps({ candidate: summaryFor(0.6, 0.5, hex('c')) })
    await registerCandidate(registry, 'm-first', 'seed-first')

    const outcome = await processNextAutomaticEvaluation(deps, baseConfig())
    expect(outcome).toEqual({ kind: 'PROMOTED', modelVersion: 'm-first' })
  })

  it('a second call with nothing pending returns IDLE', async () => {
    const { deps } = newDeps({ candidate: summaryFor(0.7, 0.55, hex('c')) })
    const outcome = await processNextAutomaticEvaluation(deps, baseConfig())
    expect(outcome).toEqual({ kind: 'IDLE' })
  })
})
