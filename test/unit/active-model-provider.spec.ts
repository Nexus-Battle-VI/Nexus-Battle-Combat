import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InMemoryAiModelArtifactRepository } from '../../src/adapters/outbound/persistence/InMemoryAiModelArtifactRepository'
import { InMemoryAiModelRegistryRepository } from '../../src/adapters/outbound/persistence/InMemoryAiModelRegistryRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { RuleBasedPolicy } from '../../src/application/policies/RuleBasedPolicy'
import { DecisionPolicySelector } from '../../src/application/services/DecisionPolicySelector'
import {
  AiModelRegistry,
  type CandidateArtifactManifest,
} from '../../src/application/services/AiModelRegistry'
import type { BattleDecisionState } from '../../src/domain/decision/BattleDecisionState'
import type { LegalAction } from '../../src/domain/decision/LegalAction'
import type { AiModelTrainingLineage } from '../../src/domain/entities/AiModelVersion'

jest.mock('../../src/infrastructure/ai/OnnxRuntimeNeuralInferenceAdapter', () => ({
  OnnxRuntimeNeuralInferenceAdapter: { create: jest.fn() },
}))

import { ActiveModelProvider } from '../../src/infrastructure/ai/ActiveModelProvider'
import { OnnxRuntimeNeuralInferenceAdapter } from '../../src/infrastructure/ai/OnnxRuntimeNeuralInferenceAdapter'

const FIXTURE_DIR = join(__dirname, '../fixtures/ai-model-registry')
const ONNX_BYTES = readFileSync(join(FIXTURE_DIR, 'model.onnx'))
const METRICS_BYTES = readFileSync(join(FIXTURE_DIR, 'metrics.json'))
const PARITY_BYTES = Buffer.from('{"fixture":"pytorch-parity-reference"}')
const ONNX_SHA256 = createHash('sha256').update(ONNX_BYTES).digest('hex')
const METRICS_SHA256 = createHash('sha256').update(METRICS_BYTES).digest('hex')
const PARITY_SHA256 = createHash('sha256').update(PARITY_BYTES).digest('hex')
const AT = new Date('2027-01-01T00:00:00.000Z')
const clock: ClockPort = { now: () => AT }
const hex = (digit: string): string => digit.repeat(64)

const STATE = JSON.parse(
  readFileSync(join(__dirname, '../../ai/tests/fixtures/golden-multi-candidate.json'), 'utf-8'),
) as {
  readonly state: BattleDecisionState
  readonly candidates: Record<string, { action: LegalAction }>
}
const LEGAL_ACTIONS = [
  STATE.candidates.basicAttack?.action,
  STATE.candidates.ability?.action,
].filter((action): action is LegalAction => action !== undefined)

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

// eslint-disable-next-line @typescript-eslint/unbound-method -- Jest reemplaza el static por un mock sin `this`.
const createAdapterMock = OnnxRuntimeNeuralInferenceAdapter.create as jest.Mock

const trainingLineage = (version: string): AiModelTrainingLineage => ({
  modelVersion: version,
  trainingRunId: version,
  modelArchitectureVersion: 'candidate-mlp-v1',
  featureSchemaVersion: 'feature-schema-v1',
  teacherVersion: 'mcts-teacher-v1',
  utilityVersion: 'pve-utility-v1',
  trainingSourceCommit: 'source-commit',
  datasetSourceCommit: 'dataset-commit',
  datasetInputFingerprint: hex('1'),
  datasetOutputFingerprint: hex('2'),
  datasetCutoff: '2027-01-01T00:00:00.000Z',
  datasetSeed: 42,
  trainingConfigSha256: hex('3'),
  trainingSeed: 7,
})

const manifest = (version: string): CandidateArtifactManifest => ({
  modelArchitectureVersion: 'candidate-mlp-v1',
  featureSchemaVersion: 'feature-schema-v1',
  teacherVersion: 'mcts-teacher-v1',
  utilityVersion: 'pve-utility-v1',
  trainingSourceCommit: 'source-commit',
  datasetSourceCommit: 'dataset-commit',
  datasetInputFingerprint: hex('1'),
  datasetOutputFingerprint: hex('2'),
  datasetCutoff: '2027-01-01T00:00:00.000Z',
  datasetSeed: 42,
  trainingConfigSha256: hex('3'),
  trainingConfig: { trainingSeed: 7 },
  datasetCounts: { battles: 4 },
  modelStateSha256: createHash('sha256').update(version).digest('hex'),
  onnxArtifactSha256: ONNX_SHA256,
  pytorchArtifactSha256: hex('6'),
  metricsFileSha256: METRICS_SHA256,
  parityReferenceSha256: PARITY_SHA256,
  artifactPurpose: 'CANDIDATE',
})

interface Harness {
  readonly registry: AiModelRegistry
  readonly artifacts: InMemoryAiModelArtifactRepository
  readonly provider: ActiveModelProvider
  readonly dir: string
}

const newHarness = async (): Promise<Harness> => {
  const artifacts = new InMemoryAiModelArtifactRepository()
  const registry = new AiModelRegistry(new InMemoryAiModelRegistryRepository(), artifacts, clock)
  const dir = await mkdtemp(join(tmpdir(), 'active-model-provider-test-'))
  const provider = new ActiveModelProvider(registry, artifacts, logger, {
    enabled: true,
    autoStart: false,
    pollIntervalMs: 10,
    nodeEnv: 'test',
    inferenceTimeoutMs: 1_000,
    workRootDir: dir,
  })
  return { registry, artifacts, provider, dir }
}

const registerEvaluating = async (registry: AiModelRegistry, version: string): Promise<void> => {
  await registry.startTraining(trainingLineage(version))
  await registry.registerCandidate({
    modelVersion: version,
    manifest: manifest(version),
    manifestBytes: Buffer.from(JSON.stringify(manifest(version))),
    onnxBytes: ONNX_BYTES,
    metricsBytes: METRICS_BYTES,
    parityReferenceBytes: PARITY_BYTES,
  })
  await registry.beginEvaluation(version)
}

const adapterReturning = (scores: readonly number[]): { score: jest.Mock } => ({
  score: jest.fn().mockResolvedValue(Float32Array.from(scores)),
})

describe('ActiveModelProvider (EN-037.3, Management #572 RT-01..10)', () => {
  const dirs: string[] = []

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('RT-01: sin ACTIVE, DecisionPolicySelector conserva RuleBased como fallback', async () => {
    const harness = await newHarness()
    dirs.push(harness.dir)
    const selector = new DecisionPolicySelector(
      { policy: harness.provider, source: 'NEURAL' },
      { policy: new RuleBasedPolicy(), source: 'RULE_BASED' },
    )

    await harness.provider.refresh()
    const selected = await selector.select(STATE.state, LEGAL_ACTIONS)

    expect(selected.source).toBe('RULE_BASED')
    expect(createAdapterMock).not.toHaveBeenCalled()
  })

  it('RT-02/03/04: carga ACTIVE y detecta una promocion sin reinicio ni copia manual', async () => {
    const harness = await newHarness()
    dirs.push(harness.dir)
    await registerEvaluating(harness.registry, 'model-v1')
    await harness.registry.promoteEvaluatedCandidate('model-v1')
    createAdapterMock.mockResolvedValueOnce(adapterReturning([1, 0]))

    await harness.provider.refresh()
    expect(await harness.provider.decide(STATE.state, LEGAL_ACTIONS)).toEqual(LEGAL_ACTIONS[0])

    await registerEvaluating(harness.registry, 'model-v2')
    await harness.registry.promoteEvaluatedCandidate('model-v2')
    createAdapterMock.mockResolvedValueOnce(adapterReturning([0, 1]))

    await harness.provider.refresh()
    expect(await harness.provider.decide(STATE.state, LEGAL_ACTIONS)).toEqual(LEGAL_ACTIONS[1])
    expect(createAdapterMock).toHaveBeenCalledTimes(2)
  })

  it('RT-05: una recarga ONNX fallida conserva el ultimo modelo valido y registra el fallo', async () => {
    const harness = await newHarness()
    dirs.push(harness.dir)
    await registerEvaluating(harness.registry, 'model-v1')
    await harness.registry.promoteEvaluatedCandidate('model-v1')
    createAdapterMock.mockResolvedValueOnce(adapterReturning([1, 0]))
    await harness.provider.refresh()

    await registerEvaluating(harness.registry, 'model-v2')
    await harness.registry.promoteEvaluatedCandidate('model-v2')
    createAdapterMock.mockRejectedValueOnce(new Error('onnx corrupto'))
    await harness.provider.refresh()

    expect(await harness.provider.decide(STATE.state, LEGAL_ACTIONS)).toEqual(LEGAL_ACTIONS[0])
    expect(logger.error).toHaveBeenCalledWith('ai_model_activation_failed', expect.any(Object))
  })

  it('RT-09: una decision iniciada termina con su delegado aunque refresh intercambie el modelo', async () => {
    const harness = await newHarness()
    dirs.push(harness.dir)
    let resolveOld: ((scores: Float32Array) => void) | undefined
    createAdapterMock.mockResolvedValueOnce({
      score: jest.fn(
        () =>
          new Promise<Float32Array>((resolve) => {
            resolveOld = resolve
          }),
      ),
    })
    await registerEvaluating(harness.registry, 'model-v1')
    await harness.registry.promoteEvaluatedCandidate('model-v1')
    await harness.provider.refresh()

    const inFlight = harness.provider.decide(STATE.state, LEGAL_ACTIONS)
    await registerEvaluating(harness.registry, 'model-v2')
    await harness.registry.promoteEvaluatedCandidate('model-v2')
    createAdapterMock.mockResolvedValueOnce(adapterReturning([0, 1]))
    await harness.provider.refresh()
    resolveOld?.(Float32Array.from([1, 0]))

    await expect(inFlight).resolves.toEqual(LEGAL_ACTIONS[0])
    await expect(harness.provider.decide(STATE.state, LEGAL_ACTIONS)).resolves.toEqual(
      LEGAL_ACTIONS[1],
    )
  })

  it('RT-10: rollback de registry se refleja en el runtime en el siguiente refresh', async () => {
    const harness = await newHarness()
    dirs.push(harness.dir)
    await registerEvaluating(harness.registry, 'model-v1')
    await harness.registry.promoteEvaluatedCandidate('model-v1')
    createAdapterMock.mockResolvedValueOnce(adapterReturning([1, 0]))
    await harness.provider.refresh()

    await registerEvaluating(harness.registry, 'model-v2')
    await harness.registry.promoteEvaluatedCandidate('model-v2')
    createAdapterMock.mockResolvedValueOnce(adapterReturning([0, 1]))
    await harness.provider.refresh()
    await harness.registry.rollbackToSuperseded('model-v1')
    createAdapterMock.mockResolvedValueOnce(adapterReturning([1, 0]))

    await harness.provider.refresh()

    expect(await harness.provider.decide(STATE.state, LEGAL_ACTIONS)).toEqual(LEGAL_ACTIONS[0])
    expect(createAdapterMock).toHaveBeenCalledTimes(3)
  })
})
