import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runContinuousTrainingIteration,
  type ContinuousTrainingPipelineConfig,
  type ContinuousTrainingPipelineDeps,
} from '../../src/infrastructure/training/ContinuousTrainingPipeline'
import type {
  ChildProcessResult,
  ChildProcessRunner,
  RunningChildProcess,
} from '../../src/infrastructure/training/ChildProcessRunner'
import { AiModelRegistry } from '../../src/application/services/AiModelRegistry'
import { InMemoryAiModelRegistryRepository } from '../../src/adapters/outbound/persistence/InMemoryAiModelRegistryRepository'
import { InMemoryAiModelArtifactRepository } from '../../src/adapters/outbound/persistence/InMemoryAiModelArtifactRepository'
import { InMemoryContinuousTrainingCoordinatorRepository } from '../../src/adapters/outbound/persistence/InMemoryContinuousTrainingCoordinatorRepository'
import { inBattleRoom, silentLogger } from '../fixtures/battle'
import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'

const AT = new Date('2027-01-01T00:00:00.000Z')
const fixedClock = { now: () => AT }

const hex = (digit: string): string => digit.repeat(64)

class FakeBattleRoomRepository implements BattleRoomRepositoryPort {
  constructor(private readonly finished: readonly BattleRoom[]) {}

  findById(): Promise<BattleRoom | null> {
    return Promise.reject(new Error('no implementado en el fake'))
  }
  findWaitingForPlayers(): Promise<readonly BattleRoom[]> {
    return Promise.reject(new Error('no implementado en el fake'))
  }
  findInBattle(): Promise<readonly BattleRoom[]> {
    return Promise.reject(new Error('no implementado en el fake'))
  }
  save(): Promise<BattleRoom> {
    return Promise.reject(new Error('no implementado en el fake'))
  }
  findFinishedSince(since: Date): Promise<readonly BattleRoom[]> {
    return Promise.resolve(
      this.finished.filter(
        (room) => new Date(room.result!.finishedAt).getTime() >= since.getTime(),
      ),
    )
  }
  findCancelledSince(): Promise<readonly BattleRoom[]> {
    return Promise.reject(new Error('no implementado en el fake'))
  }
  findActiveByParticipant(): Promise<readonly BattleRoom[]> {
    return Promise.reject(new Error('no implementado en el fake'))
  }
  findByTournamentOperationId(): Promise<BattleRoom | null> {
    return Promise.reject(new Error('no implementado en el fake'))
  }
}

const finishedRoomAt = (finishedAt: Date): BattleRoom =>
  inBattleRoom().finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, finishedAt)

const DATASET_MANIFEST_TRAINABLE = {
  manifestVersion: 'dataset-manifest-v1',
  featureSchemaVersion: 'feature-schema-v1',
  featureDimension: 72,
  decisionStateSchemaVersion: 1,
  teacherVersion: 'mcts-teacher-v1',
  utilityVersion: 'pve-utility-v1',
  labelSchemaVersion: '1',
  splitStrategyVersion: 'battle-hash-split-v1',
  cutoff: '2027-01-01T00:00:00.000Z',
  sourceCommit: 'dataset-source-commit',
  datasetSeed: 42,
  counts: {
    battles: 4,
    decisions: 7,
    candidates: 13,
    trainBattles: 2,
    validationBattles: 1,
    testBattles: 1,
    trainDecisions: 3,
    validationDecisions: 2,
    testDecisions: 2,
  },
  exclusions: { endTurn: 0, missingLabelExpected: 0, missingLabelUnexpected: 0 },
  inputFingerprint: hex('1'),
  outputFingerprint: hex('2'),
}

const DATASET_MANIFEST_NOT_TRAINABLE = {
  ...DATASET_MANIFEST_TRAINABLE,
  counts: { ...DATASET_MANIFEST_TRAINABLE.counts, testDecisions: 0 },
}

const IDENTITY = {
  runId: 'candidate-mlp-v1-faketest0001',
  trainingConfigSha256: hex('3'),
  datasetOutputFingerprint: DATASET_MANIFEST_TRAINABLE.outputFingerprint,
}

const onnxBytes = Buffer.from('fake-onnx-bytes-for-continuous-training-pipeline-unit-test')
const metricsBytes = Buffer.from('{"testLoss":0.1}')

const trainingManifestFor = (identity: typeof IDENTITY): Record<string, unknown> => ({
  trainingManifestVersion: 'training-manifest-v1',
  modelArchitectureVersion: 'candidate-mlp-v1',
  featureSchemaVersion: 'feature-schema-v1',
  featureDimension: 72,
  decisionStateSchemaVersion: 1,
  teacherVersion: 'mcts-teacher-v1',
  utilityVersion: 'pve-utility-v1',
  labelSchemaVersion: '1',
  datasetManifestVersion: 'dataset-manifest-v1',
  datasetInputFingerprint: DATASET_MANIFEST_TRAINABLE.inputFingerprint,
  datasetOutputFingerprint: identity.datasetOutputFingerprint,
  datasetSourceCommit: DATASET_MANIFEST_TRAINABLE.sourceCommit,
  datasetCutoff: DATASET_MANIFEST_TRAINABLE.cutoff,
  datasetSeed: DATASET_MANIFEST_TRAINABLE.datasetSeed,
  datasetCounts: DATASET_MANIFEST_TRAINABLE.counts,
  trainingSourceCommit: 'training-source-commit',
  pythonVersion: '3.13.0',
  torchVersion: '2.0.0',
  numpyVersion: '2.0.0',
  onnxVersion: '1.17.0',
  onnxOpsetVersion: 18,
  trainingConfig: { trainingSeed: 7 },
  trainingConfigSha256: identity.trainingConfigSha256,
  modelContract: {
    inputName: 'candidate_features',
    inputDtype: 'float32',
    inputRank: 2,
    featureDimension: 72,
    candidateAxisDynamic: true,
    outputName: 'scores',
    outputDtype: 'float32',
    outputRank: 1,
  },
  bestEpoch: 0,
  epochsRun: 1,
  stoppedEarly: false,
  trainableParameterCount: 6785,
  modelStateSha256: hex('4'),
  pytorchArtifactSha256: hex('5'),
  onnxArtifactSha256: createHash('sha256').update(onnxBytes).digest('hex'),
  metricsFileSha256: createHash('sha256').update(metricsBytes).digest('hex'),
  artifactPurpose: 'CANDIDATE',
})

interface FakePythonFixture {
  readonly datasetManifest: Record<string, unknown>
  readonly identity: typeof IDENTITY
  readonly trainingManifest: Record<string, unknown>
  readonly failDatasetBuild?: boolean
  readonly failTraining?: boolean
  readonly onTrainingStart?: () => void
}

const argAfter = (args: readonly string[], flag: string): string => {
  const index = args.indexOf(flag)
  if (index === -1) throw new Error(`falta "${flag}" en los argumentos del fake: ${args.join(' ')}`)
  const value = args[index + 1]
  if (value === undefined) throw new Error(`"${flag}" sin valor en el fake.`)
  return value
}

const fakeResult = (outcome: ChildProcessResult): RunningChildProcess => ({
  result: Promise.resolve(outcome),
  cancel: () => undefined,
})

const createFakePythonRunner = (fixture: FakePythonFixture): ChildProcessRunner => {
  return (_command, args) => {
    if (args.includes('nexus-combat-dataset')) {
      const promise = (async (): Promise<ChildProcessResult> => {
        if (fixture.failDatasetBuild === true) {
          return { exitCode: 1, stdout: '', stderr: 'error: fake dataset build failure' }
        }
        const outputDir = argAfter(args, '--output')
        await mkdir(outputDir, { recursive: true })
        await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(fixture.datasetManifest))
        return { exitCode: 0, stdout: '', stderr: '' }
      })()
      return { result: promise, cancel: () => undefined }
    }

    if (args.includes('nexus-combat-train')) {
      if (args.includes('--emit-identity-only')) {
        return fakeResult({ exitCode: 0, stdout: JSON.stringify(fixture.identity), stderr: '' })
      }

      const promise = (async (): Promise<ChildProcessResult> => {
        fixture.onTrainingStart?.()
        if (fixture.failTraining === true) {
          return { exitCode: 1, stdout: '', stderr: 'error: fake training failure' }
        }
        const artifactsDir = argAfter(args, '--output')
        const runDir = join(artifactsDir, fixture.identity.runId)
        await mkdir(runDir, { recursive: true })
        await writeFile(join(runDir, 'model.onnx'), onnxBytes)
        await writeFile(join(runDir, 'metrics.json'), metricsBytes)
        await writeFile(
          join(runDir, 'training-manifest.json'),
          JSON.stringify(fixture.trainingManifest),
        )
        return { exitCode: 0, stdout: '', stderr: '' }
      })()
      return { result: promise, cancel: () => undefined }
    }

    throw new Error(`comando inesperado en el fake python runner: ${args.join(' ')}`)
  }
}

const baseConfig = (workRootDir: string): ContinuousTrainingPipelineConfig => ({
  ownerId: 'worker-under-test',
  aiDir: '/fake/ai',
  pythonCommand: 'fake-uv',
  mongoUri: 'mongodb://fake',
  databaseName: 'combat',
  datasetSeed: 42,
  trainingSeed: 7,
  sourceCommit: 'training-source-commit',
  gracePeriodMs: 5 * 60_000,
  leaseDurationMs: 60_000,
  heartbeatIntervalMs: 10_000,
  datasetBuildTimeoutMs: 10_000,
  trainingTimeoutMs: 10_000,
  identityTimeoutMs: 10_000,
  workRootDir,
})

describe('runContinuousTrainingIteration (EN-037.2, Management #571)', () => {
  let workRootDir: string

  beforeEach(async () => {
    workRootDir = await mkdtemp(join(tmpdir(), 'ai-training-pipeline-test-'))
  })

  const newDeps = (
    battleRooms: BattleRoomRepositoryPort,
    runChildProcess: ChildProcessRunner,
  ): ContinuousTrainingPipelineDeps => ({
    battleRooms,
    coordinator: new InMemoryContinuousTrainingCoordinatorRepository(),
    registry: new AiModelRegistry(
      new InMemoryAiModelRegistryRepository(),
      new InMemoryAiModelArtifactRepository(),
      fixedClock,
    ),
    clock: fixedClock,
    logger: silentLogger,
    runChildProcess,
  })

  it('is IDLE when no battle has finished since the scan watermark', async () => {
    const deps = newDeps(
      new FakeBattleRoomRepository([]),
      createFakePythonRunner({} as FakePythonFixture),
    )
    const { outcome } = await runContinuousTrainingIteration(
      deps,
      baseConfig(workRootDir),
      new Date(0),
    )
    expect(outcome).toEqual({ kind: 'IDLE' })
  })

  it('is LEASE_BUSY when another owner already holds a valid lease', async () => {
    const battleRoom = finishedRoomAt(new Date('2026-12-01T00:00:00.000Z'))
    const deps = newDeps(
      new FakeBattleRoomRepository([battleRoom]),
      createFakePythonRunner({} as FakePythonFixture),
    )
    await deps.coordinator.tryClaimLease('someone-else', 10 * 60_000, AT)

    const { outcome } = await runContinuousTrainingIteration(
      deps,
      baseConfig(workRootDir),
      new Date(0),
    )
    expect(outcome).toEqual({ kind: 'LEASE_BUSY' })
  })

  it('records NOT_TRAINABLE without ever calling nexus-combat-train when the dataset has an empty split', async () => {
    const battleRoom = finishedRoomAt(new Date('2026-12-01T00:00:00.000Z'))
    const runner = createFakePythonRunner({
      datasetManifest: DATASET_MANIFEST_NOT_TRAINABLE,
      identity: IDENTITY,
      trainingManifest: trainingManifestFor(IDENTITY),
    })
    const deps = newDeps(new FakeBattleRoomRepository([battleRoom]), runner)

    const { outcome } = await runContinuousTrainingIteration(
      deps,
      baseConfig(workRootDir),
      new Date(0),
    )

    expect(outcome.kind).toBe('NOT_TRAINABLE')
    const snapshot = await deps.coordinator.getSnapshot()
    expect(snapshot.leaseState).toBe('IDLE')
    expect(snapshot.lastRunOutcome).toBe('NOT_TRAINABLE')
  })

  it('full happy path: builds the dataset, registers TRAINING, trains, and registers CANDIDATE', async () => {
    const battleRoom = finishedRoomAt(new Date('2026-12-01T00:00:00.000Z'))
    const runner = createFakePythonRunner({
      datasetManifest: DATASET_MANIFEST_TRAINABLE,
      identity: IDENTITY,
      trainingManifest: trainingManifestFor(IDENTITY),
    })
    const deps = newDeps(new FakeBattleRoomRepository([battleRoom]), runner)

    const { outcome } = await runContinuousTrainingIteration(
      deps,
      baseConfig(workRootDir),
      new Date(0),
    )

    expect(outcome).toEqual({ kind: 'SUCCESS', modelVersion: IDENTITY.runId })

    const registered = await deps.registry.findByVersion(IDENTITY.runId)
    expect(registered?.state).toBe('CANDIDATE')

    const snapshot = await deps.coordinator.getSnapshot()
    expect(snapshot.leaseState).toBe('IDLE')
    expect(snapshot.lastRunOutcome).toBe('SUCCESS')
    expect(snapshot.lastRunModelVersion).toBe(IDENTITY.runId)
  })

  it('classifies a dataset build failure as DATASET_BUILD_FAILED and never advances processedThrough', async () => {
    const battleRoom = finishedRoomAt(new Date('2026-12-01T00:00:00.000Z'))
    const runner = createFakePythonRunner({
      datasetManifest: DATASET_MANIFEST_TRAINABLE,
      identity: IDENTITY,
      trainingManifest: trainingManifestFor(IDENTITY),
      failDatasetBuild: true,
    })
    const deps = newDeps(new FakeBattleRoomRepository([battleRoom]), runner)

    const before = await deps.coordinator.getSnapshot()
    const { outcome } = await runContinuousTrainingIteration(
      deps,
      baseConfig(workRootDir),
      new Date(0),
    )

    expect(outcome.kind).toBe('FAILED')
    if (outcome.kind === 'FAILED') expect(outcome.reasonCode).toBe('DATASET_BUILD_FAILED')

    const after = await deps.coordinator.getSnapshot()
    expect(after.processedThrough).toEqual(before.processedThrough)
    expect(after.consecutiveFailureCount).toBe(1)
    expect(after.leaseState).toBe('IDLE')
  })

  it('classifies a real training failure as TRAINING_PROCESS_FAILED and leaves the version abandoned in TRAINING (never auto-rejected)', async () => {
    const battleRoom = finishedRoomAt(new Date('2026-12-01T00:00:00.000Z'))
    const runner = createFakePythonRunner({
      datasetManifest: DATASET_MANIFEST_TRAINABLE,
      identity: IDENTITY,
      trainingManifest: trainingManifestFor(IDENTITY),
      failTraining: true,
    })
    const deps = newDeps(new FakeBattleRoomRepository([battleRoom]), runner)

    const { outcome } = await runContinuousTrainingIteration(
      deps,
      baseConfig(workRootDir),
      new Date(0),
    )

    expect(outcome.kind).toBe('FAILED')
    if (outcome.kind === 'FAILED') expect(outcome.reasonCode).toBe('TRAINING_PROCESS_FAILED')

    // `startTraining` SI se registro antes de invocar PyTorch (#571 §8.1) --
    // la version queda abandonada en TRAINING, nunca auto-rechazada
    // (decision deliberada, ver docstring de `ContinuousTrainingPipeline.ts`).
    const registered = await deps.registry.findByVersion(IDENTITY.runId)
    expect(registered?.state).toBe('TRAINING')
  })

  it('CT-12-ish: a lease lost DURING training aborts before registerCandidate, never confirms a stale result', async () => {
    const battleRoom = finishedRoomAt(new Date('2026-12-01T00:00:00.000Z'))
    const deps0 = newDeps(
      new FakeBattleRoomRepository([battleRoom]),
      createFakePythonRunner({} as FakePythonFixture),
    )
    const coordinator = deps0.coordinator as InMemoryContinuousTrainingCoordinatorRepository

    const runner = createFakePythonRunner({
      datasetManifest: DATASET_MANIFEST_TRAINABLE,
      identity: IDENTITY,
      trainingManifest: trainingManifestFor(IDENTITY),
      onTrainingStart: () => {
        coordinator.__testOnlyForceReclaim('intruder-worker')
      },
    })
    const deps: ContinuousTrainingPipelineDeps = { ...deps0, runChildProcess: runner }

    const { outcome } = await runContinuousTrainingIteration(
      deps,
      baseConfig(workRootDir),
      new Date(0),
    )

    expect(outcome.kind).toBe('FAILED')
    if (outcome.kind === 'FAILED') expect(outcome.reasonCode).toBe('LEASE_LOST')

    const registered = await deps.registry.findByVersion(IDENTITY.runId)
    expect(registered?.state === 'CANDIDATE').toBe(false)
  })
})
