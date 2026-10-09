import { createHash } from 'node:crypto'

import {
  AiModelRegistry,
  type CandidateArtifactManifest,
} from '../../src/application/services/AiModelRegistry'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { AiModelTrainingLineage } from '../../src/domain/entities/AiModelVersion'
import type { AiModelVersion } from '../../src/domain/entities/AiModelVersion'
import {
  ActiveModelConflictError,
  ArtifactConflictError,
  ArtifactPurposeNotCandidateError,
  ModelArtifactHashMismatchError,
  ModelArtifactNotFoundError,
  ModelTrainingLineageMismatchError,
  ModelVersionConflictError,
} from '../../src/domain/errors/AiModelRegistryErrors'
import { InMemoryAiModelRegistryRepository } from '../../src/adapters/outbound/persistence/InMemoryAiModelRegistryRepository'
import { InMemoryAiModelArtifactRepository } from '../../src/adapters/outbound/persistence/InMemoryAiModelArtifactRepository'

const AT = new Date('2027-01-01T00:00:00.000Z')
const fixedClock = (): ClockPort => ({ now: () => AT })

const hex = (digit: string): string => digit.repeat(64)

const onnxBytes = Buffer.from('fake-onnx-bytes-for-ai-model-registry-unit-test')
const metricsBytes = Buffer.from('{"winRate":null}')
const manifestBytes = Buffer.from('{"fake":"manifest-bytes-for-unit-test"}')
const parityReferenceBytes = Buffer.from('{"fake":"pytorch-parity-reference-for-unit-test"}')
const onnxArtifactSha256 = createHash('sha256').update(onnxBytes).digest('hex')
const metricsFileSha256 = createHash('sha256').update(metricsBytes).digest('hex')
const parityReferenceSha256 = createHash('sha256').update(parityReferenceBytes).digest('hex')

/** Fuente UNICA para training lineage + manifest, para que nunca diverjan por accidente entre tests. */
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

const manifest = (
  overrides: Partial<CandidateArtifactManifest> = {},
): CandidateArtifactManifest => ({
  modelArchitectureVersion: FIXED_TRAINING_FIELDS.modelArchitectureVersion,
  featureSchemaVersion: FIXED_TRAINING_FIELDS.featureSchemaVersion,
  teacherVersion: FIXED_TRAINING_FIELDS.teacherVersion,
  utilityVersion: FIXED_TRAINING_FIELDS.utilityVersion,
  trainingSourceCommit: FIXED_TRAINING_FIELDS.trainingSourceCommit,
  datasetSourceCommit: FIXED_TRAINING_FIELDS.datasetSourceCommit,
  datasetInputFingerprint: FIXED_TRAINING_FIELDS.datasetInputFingerprint,
  datasetOutputFingerprint: FIXED_TRAINING_FIELDS.datasetOutputFingerprint,
  datasetCutoff: FIXED_TRAINING_FIELDS.datasetCutoff,
  datasetSeed: FIXED_TRAINING_FIELDS.datasetSeed,
  trainingConfigSha256: FIXED_TRAINING_FIELDS.trainingConfigSha256,
  trainingConfig: { trainingSeed: FIXED_TRAINING_FIELDS.trainingSeed },
  datasetCounts: { battles: 4 },
  modelStateSha256: hex('4'),
  onnxArtifactSha256,
  pytorchArtifactSha256: hex('6'),
  metricsFileSha256,
  parityReferenceSha256,
  artifactPurpose: 'CANDIDATE',
  ...overrides,
})

const newRegistry = (): AiModelRegistry =>
  new AiModelRegistry(
    new InMemoryAiModelRegistryRepository(),
    new InMemoryAiModelArtifactRepository(),
    fixedClock(),
  )

describe('AiModelRegistry (EN-037.1, Management #570 §48, §53-58)', () => {
  it('registers a candidate with a real matching ONNX/metrics byte hash', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('m-1'))

    const candidate = await registry.registerCandidate({
      modelVersion: 'm-1',
      manifest: manifest(),
      manifestBytes,
      onnxBytes,
      metricsBytes,
      parityReferenceBytes,
    })

    expect(candidate.state).toBe('CANDIDATE')
    expect(candidate.artifactLineage?.onnxArtifactSha256).toBe(onnxArtifactSha256)
    expect(candidate.artifactLineage?.metrics).toEqual({ winRate: null })
    expect(candidate.artifactLineage?.trainingManifestSha256).toBe(
      createHash('sha256').update(manifestBytes).digest('hex'),
    )
  })

  it('rejects registration when the real ONNX byte hash does not match the manifest', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('m-2'))

    await expect(
      registry.registerCandidate({
        modelVersion: 'm-2',
        manifest: manifest({ onnxArtifactSha256: hex('9') }),
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      }),
    ).rejects.toBeInstanceOf(ModelArtifactHashMismatchError)
  })

  it('rejects registration when the real metrics byte hash does not match the manifest', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('m-3'))

    await expect(
      registry.registerCandidate({
        modelVersion: 'm-3',
        manifest: manifest({ metricsFileSha256: hex('9') }),
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      }),
    ).rejects.toBeInstanceOf(ModelArtifactHashMismatchError)
  })

  it('rejects SMOKE_TEST at registerCandidate (revision de codigo: nunca entra al ciclo productivo)', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('m-4'))

    await expect(
      registry.registerCandidate({
        modelVersion: 'm-4',
        manifest: manifest({ artifactPurpose: 'SMOKE_TEST' }),
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      }),
    ).rejects.toBeInstanceOf(ArtifactPurposeNotCandidateError)

    const stillTraining = await registry.findByVersion('m-4')
    expect(stillTraining?.state).toBe('TRAINING')
  })

  it('rejects a manifest whose training fields do not match the registered training lineage (lineage binding)', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('m-binding'))

    await expect(
      registry.registerCandidate({
        modelVersion: 'm-binding',
        manifest: manifest({ trainingSourceCommit: 'un-commit-de-otro-training' }),
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      }),
    ).rejects.toBeInstanceOf(ModelTrainingLineageMismatchError)
  })

  it('rejects a manifest whose trainingConfig.trainingSeed does not match the registered trainingSeed', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('m-seed-mismatch'))

    await expect(
      registry.registerCandidate({
        modelVersion: 'm-seed-mismatch',
        manifest: manifest({ trainingConfig: { trainingSeed: 999 } }),
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      }),
    ).rejects.toBeInstanceOf(ModelTrainingLineageMismatchError)
  })

  it('full happy path TRAINING -> CANDIDATE -> EVALUATING -> ACTIVE', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('m-5'))
    await registry.registerCandidate({
      modelVersion: 'm-5',
      manifest: manifest(),
      manifestBytes,
      onnxBytes,
      metricsBytes,
      parityReferenceBytes,
    })
    await registry.beginEvaluation('m-5')
    const active = await registry.activate('m-5')

    expect(active.state).toBe('ACTIVE')
    expect(await registry.findActive()).not.toBeNull()
  })

  it('activate() re-checks artifact existence and hash integrity at read time (#570 §34)', async () => {
    const artifactRepository = new InMemoryAiModelArtifactRepository()
    const registry = new AiModelRegistry(
      new InMemoryAiModelRegistryRepository(),
      artifactRepository,
      fixedClock(),
    )
    await registry.startTraining(trainingLineage('m-6'))
    await registry.registerCandidate({
      modelVersion: 'm-6',
      manifest: manifest(),
      manifestBytes,
      onnxBytes,
      metricsBytes,
      parityReferenceBytes,
    })
    await registry.beginEvaluation('m-6')

    // Simula un artefacto desaparecido del store (#570 §34: nunca asumir
    // que Mongo jamas puede contener datos corruptos/manipulados).
    ;(artifactRepository as unknown as { artifacts: Map<string, unknown> }).artifacts.clear()

    await expect(registry.activate('m-6')).rejects.toBeInstanceOf(ModelArtifactNotFoundError)
  })

  it('a second concurrent activate() against an existing ACTIVE version is rejected (#570 §41-42)', async () => {
    const registryRepository = new InMemoryAiModelRegistryRepository()
    const registry = new AiModelRegistry(
      registryRepository,
      new InMemoryAiModelArtifactRepository(),
      fixedClock(),
    )

    for (const modelVersion of ['m-7a', 'm-7b']) {
      await registry.startTraining(trainingLineage(modelVersion))
      await registry.registerCandidate({
        modelVersion,
        manifest: manifest(),
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      })
      await registry.beginEvaluation(modelVersion)
    }

    await registry.activate('m-7a')
    await expect(registry.activate('m-7b')).rejects.toBeInstanceOf(ActiveModelConflictError)
  })

  it('registering the identical artifact bytes for two candidates is idempotent (content-addressed)', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('m-8a'))
    await registry.startTraining(trainingLineage('m-8b'))

    await registry.registerCandidate({
      modelVersion: 'm-8a',
      manifest: manifest(),
      manifestBytes,
      onnxBytes,
      metricsBytes,
      parityReferenceBytes,
    })
    await expect(
      registry.registerCandidate({
        modelVersion: 'm-8b',
        manifest: manifest(),
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      }),
    ).resolves.toBeDefined()
  })

  it('registering different bytes under the SAME declared hash is an ArtifactConflictError', async () => {
    const artifactRepository = new InMemoryAiModelArtifactRepository()
    await artifactRepository.put(
      onnxArtifactSha256,
      Buffer.from('already-stored-different-bytes'),
      AT,
    )
    const registry = new AiModelRegistry(
      new InMemoryAiModelRegistryRepository(),
      artifactRepository,
      fixedClock(),
    )
    await registry.startTraining(trainingLineage('m-9'))

    await expect(
      registry.registerCandidate({
        modelVersion: 'm-9',
        manifest: manifest(),
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      }),
    ).rejects.toBeInstanceOf(ArtifactConflictError)
  })

  it('a revision race: two writers starting from the SAME stale revision, only one wins (#570 §40)', async () => {
    const registryRepository = new InMemoryAiModelRegistryRepository()
    const registry = new AiModelRegistry(
      registryRepository,
      new InMemoryAiModelArtifactRepository(),
      fixedClock(),
    )
    await registry.startTraining(trainingLineage('m-10'))
    const candidate = await registry.registerCandidate({
      modelVersion: 'm-10',
      manifest: manifest(),
      manifestBytes,
      onnxBytes,
      metricsBytes,
      parityReferenceBytes,
    })
    expect(candidate.revision).toBe(1)

    // Dos escritores parten del MISMO objeto en revision 1 (la lectura
    // obsoleta que produciria una condicion de carrera real entre dos
    // procesos) y ambos intentan avanzar a EVALUATING.
    const fromWriterA = candidate.beginEvaluation(AT)
    const fromWriterB = candidate.beginEvaluation(AT)

    await registryRepository.replaceWithExpectedRevision(fromWriterA, candidate.revision)
    await expect(
      registryRepository.replaceWithExpectedRevision(fromWriterB, candidate.revision),
    ).rejects.toBeInstanceOf(ModelVersionConflictError)
  })

  it('operating on a modelVersion that was never created rejects with ModelVersionConflictError', async () => {
    const registry = newRegistry()
    await expect(registry.beginEvaluation('never-existed')).rejects.toBeInstanceOf(
      ModelVersionConflictError,
    )
  })

  it('PR-10: a controlled promotion failure restores the previous ACTIVE', async () => {
    class FailCandidateActivationRepository extends InMemoryAiModelRegistryRepository {
      private failed = false

      override replaceWithExpectedRevision(
        version: AiModelVersion,
        expectedRevision: number,
      ): Promise<void> {
        if (!this.failed && version.modelVersion === 'm-new' && version.state === 'ACTIVE') {
          this.failed = true
          return Promise.reject(new Error('simulated candidate activation failure'))
        }
        return super.replaceWithExpectedRevision(version, expectedRevision)
      }
    }

    const repository = new FailCandidateActivationRepository()
    const registry = new AiModelRegistry(
      repository,
      new InMemoryAiModelArtifactRepository(),
      fixedClock(),
    )

    for (const modelVersion of ['m-old', 'm-new']) {
      await registry.startTraining(trainingLineage(modelVersion))
      await registry.registerCandidate({
        modelVersion,
        manifest: manifest(),
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      })
      await registry.beginEvaluation(modelVersion)
    }

    await registry.promoteEvaluatedCandidate('m-old')
    await expect(registry.promoteEvaluatedCandidate('m-new')).rejects.toThrow(
      'simulated candidate activation failure',
    )

    await expect(registry.findActive()).resolves.toMatchObject({
      modelVersion: 'm-old',
      state: 'ACTIVE',
    })
    await expect(registry.findByVersion('m-new')).resolves.toMatchObject({
      state: 'EVALUATING',
    })
  })
})
