import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import {
  AiModelRegistry,
  type CandidateArtifactManifest,
} from '../../src/application/services/AiModelRegistry'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { AiModelTrainingLineage } from '../../src/domain/entities/AiModelVersion'
import {
  ActiveModelConflictError,
  ModelVersionConflictError,
} from '../../src/domain/errors/AiModelRegistryErrors'
import {
  AI_MODEL_VERSIONS_COLLECTION,
  MongoAiModelRegistryRepository,
} from '../../src/adapters/outbound/persistence/MongoAiModelRegistryRepository'
import {
  AI_MODEL_ARTIFACTS_COLLECTION,
  MongoAiModelArtifactRepository,
} from '../../src/adapters/outbound/persistence/MongoAiModelArtifactRepository'
import { parseAndValidateModelTrainingManifest } from '../../src/infrastructure/ai/AiModelTrainingManifestV1'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

const AT = new Date('2027-01-01T00:00:00.000Z')
const fixedClock = (): ClockPort => ({ now: () => AT })

const FIXTURE_DIR = join(__dirname, '../fixtures/ai-model-registry')
const realOnnxBytes = readFileSync(join(FIXTURE_DIR, 'model.onnx'))
const realMetricsBytes = readFileSync(join(FIXTURE_DIR, 'metrics.json'))
const realManifest = parseAndValidateModelTrainingManifest(
  JSON.parse(readFileSync(join(FIXTURE_DIR, 'training-manifest.json'), 'utf8')),
)

const candidateManifest = (
  overrides: Partial<CandidateArtifactManifest> = {},
): CandidateArtifactManifest => ({
  modelStateSha256: realManifest.modelStateSha256,
  onnxArtifactSha256: realManifest.onnxArtifactSha256,
  pytorchArtifactSha256: realManifest.pytorchArtifactSha256,
  metricsFileSha256: realManifest.metricsFileSha256,
  artifactPurpose: realManifest.artifactPurpose,
  ...overrides,
})

const trainingLineage = (modelVersion: string): AiModelTrainingLineage => ({
  modelVersion,
  trainingRunId: modelVersion,
  modelArchitectureVersion: realManifest.modelArchitectureVersion,
  featureSchemaVersion: realManifest.featureSchemaVersion,
  teacherVersion: realManifest.teacherVersion,
  utilityVersion: realManifest.utilityVersion,
  trainingSourceCommit: realManifest.trainingSourceCommit,
  datasetSourceCommit: realManifest.datasetSourceCommit,
  datasetInputFingerprint: realManifest.datasetInputFingerprint,
  datasetOutputFingerprint: realManifest.datasetOutputFingerprint,
  datasetCutoff: realManifest.datasetCutoff,
  datasetSeed: realManifest.datasetSeed,
  trainingConfigSha256: realManifest.trainingConfigSha256,
})

/**
 * Pruebas contra Mongo REAL (EN-037.1, Management #570 §96-98): el
 * proyecto ya usa Mongo real en CI para `test:db`, nunca un sustituto en
 * memoria -- en particular la unicidad ACTIVE (indice unico parcial) y la
 * concurrencia optimista solo se demuestran de verdad contra el motor.
 */
describe('AiModelRegistry sobre MongoDB real (EN-037.1, Management #570)', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient | undefined
  let db: Db | undefined

  beforeAll(async () => {
    const externalUri = process.env.MONGO_TEST_URI
    if (externalUri === undefined) container = await new MongoDBContainer('mongo:8.0').start()
    const options = {
      uri: externalUri ?? `${container!.getConnectionString()}/?directConnection=true`,
      databaseName: `ai_model_registry_${String(Date.now())}`,
    }
    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
  }, 120_000)

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
    await container?.stop()
  })

  const newRegistry = (): AiModelRegistry =>
    new AiModelRegistry(
      new MongoAiModelRegistryRepository(db!),
      new MongoAiModelArtifactRepository(db!),
      fixedClock(),
    )

  it('registers migration 027 right after the frozen migration history', () => {
    expect(MIGRATIONS.slice(25, 27).map((migration) => migration.name)).toEqual([
      '026-battle-rooms-tournament-cardinality',
      '027-ai-model-registry',
    ])
  })

  it('creates the expected indexes on ai-model-versions, including the partial unique ACTIVE index', async () => {
    const indexes = await db!.collection(AI_MODEL_VERSIONS_COLLECTION).indexes()
    const names = indexes.map((index) => index.name)

    expect(names).toEqual(
      expect.arrayContaining([
        '_id_',
        'training_run_id_unique',
        'model_state_sha256',
        'active_unique',
      ]),
    )
    expect(indexes.find((index) => index.name === 'active_unique')).toMatchObject({
      unique: true,
      key: { state: 1 },
      partialFilterExpression: { state: 'ACTIVE' },
    })
    expect(indexes.find((index) => index.name === 'training_run_id_unique')).toMatchObject({
      unique: true,
    })
  })

  it('creates the ai-model-artifacts collection', async () => {
    const collections = await db!.listCollections({ name: AI_MODEL_ARTIFACTS_COLLECTION }).toArray()
    expect(collections).toHaveLength(1)
  })

  it('registers a REAL CANDIDATE using the #567 pipeline model.onnx/manifest fixture end to end', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('real-fixture-1'))

    const candidate = await registry.registerCandidate({
      modelVersion: 'real-fixture-1',
      manifest: candidateManifest(),
      onnxBytes: realOnnxBytes,
      metricsBytes: realMetricsBytes,
    })

    expect(candidate.state).toBe('CANDIDATE')
    expect(candidate.artifactLineage?.onnxArtifactSha256).toBe(realManifest.onnxArtifactSha256)
    expect(candidate.artifactLineage?.artifactPurpose).toBe('SMOKE_TEST')
  })

  it('a byte-corrupted ONNX never reaches CANDIDATE (hash mismatch, rejected before any state change)', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('corrupt-onnx'))
    const corrupted = Buffer.from(realOnnxBytes)
    corrupted[0] = (corrupted[0]! + 1) % 256

    await expect(
      registry.registerCandidate({
        modelVersion: 'corrupt-onnx',
        manifest: candidateManifest(),
        onnxBytes: corrupted,
        metricsBytes: realMetricsBytes,
      }),
    ).rejects.toThrow()

    const stored = await registry.findByVersion('corrupt-onnx')
    expect(stored?.state).toBe('TRAINING')
  })

  it('a byte-corrupted metrics file never reaches CANDIDATE', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('corrupt-metrics'))
    const corrupted = Buffer.concat([realMetricsBytes, Buffer.from('x')])

    await expect(
      registry.registerCandidate({
        modelVersion: 'corrupt-metrics',
        manifest: candidateManifest(),
        onnxBytes: realOnnxBytes,
        metricsBytes: corrupted,
      }),
    ).rejects.toThrow()

    const stored = await registry.findByVersion('corrupt-metrics')
    expect(stored?.state).toBe('TRAINING')
  })

  it('a feature-schema-incompatible manifest is rejected at the parsing boundary, never reaches CANDIDATE', () => {
    const raw = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'training-manifest.json'), 'utf8'),
    ) as Record<string, unknown>

    expect(() =>
      parseAndValidateModelTrainingManifest({ ...raw, featureSchemaVersion: 'v999' }),
    ).toThrow()
  })

  it('SMOKE_TEST reaches CANDIDATE/EVALUATING honestly but NEVER ACTIVE (#570 §19, §37, §88, §117-119)', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('smoke-never-active'))
    await registry.registerCandidate({
      modelVersion: 'smoke-never-active',
      manifest: candidateManifest(),
      onnxBytes: realOnnxBytes,
      metricsBytes: realMetricsBytes,
    })
    const evaluating = await registry.beginEvaluation('smoke-never-active')
    expect(evaluating.artifactLineage?.artifactPurpose).toBe('SMOKE_TEST')

    await expect(registry.activate('smoke-never-active')).rejects.toThrow(/SMOKE_TEST/)

    const stillNotActive = await registry.findByVersion('smoke-never-active')
    expect(stillNotActive?.state).toBe('EVALUATING')
  })

  it('exactly one of two concurrent activate() calls wins the REAL Mongo partial unique ACTIVE index', async () => {
    const registry = newRegistry()
    for (const modelVersion of ['race-a', 'race-b']) {
      await registry.startTraining(trainingLineage(modelVersion))
      await registry.registerCandidate({
        modelVersion,
        manifest: candidateManifest({ artifactPurpose: 'CANDIDATE' }),
        onnxBytes: realOnnxBytes,
        metricsBytes: realMetricsBytes,
      })
      await registry.beginEvaluation(modelVersion)
    }

    const results = await Promise.allSettled([
      registry.activate('race-a'),
      registry.activate('race-b'),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(ActiveModelConflictError)

    const active = await registry.findActive()
    expect(active).not.toBeNull()
  })

  it('restart-persistence: a NEW repository instance against the same DB recovers state/metadata/history/artifact exactly', async () => {
    const firstProcessRegistry = newRegistry()
    await firstProcessRegistry.startTraining(trainingLineage('restart-check'))
    await firstProcessRegistry.registerCandidate({
      modelVersion: 'restart-check',
      manifest: candidateManifest(),
      onnxBytes: realOnnxBytes,
      metricsBytes: realMetricsBytes,
    })
    await firstProcessRegistry.beginEvaluation('restart-check')

    // Instancia NUEVA, simulando un proceso que reinicia y vuelve a leer.
    const secondProcessRegistry = newRegistry()
    const recovered = await secondProcessRegistry.findByVersion('restart-check')

    expect(recovered?.state).toBe('EVALUATING')
    expect(recovered?.revision).toBe(2)
    expect(recovered?.artifactLineage?.onnxArtifactSha256).toBe(realManifest.onnxArtifactSha256)
    expect(recovered?.stateHistory.map((entry) => entry.to)).toEqual([
      'TRAINING',
      'CANDIDATE',
      'EVALUATING',
    ])

    const artifactRepository = new MongoAiModelArtifactRepository(db!)
    const recoveredArtifact = await artifactRepository.getBySha256(realManifest.onnxArtifactSha256)
    expect(Buffer.compare(recoveredArtifact!.bytes, realOnnxBytes)).toBe(0)
  })

  it('re-registering the SAME training lineage twice is idempotent (no duplicate, no error)', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('idempotent-training'))
    await expect(
      registry.startTraining(trainingLineage('idempotent-training')),
    ).resolves.toBeDefined()
  })

  it('re-registering a DIFFERENT training lineage under the same modelVersion is a conflict', async () => {
    const registry = newRegistry()
    await registry.startTraining(trainingLineage('conflict-training'))

    await expect(
      registry.startTraining({
        ...trainingLineage('conflict-training'),
        trainingSourceCommit: 'a-different-commit',
      }),
    ).rejects.toBeInstanceOf(ModelVersionConflictError)
  })

  it('a revision race on real Mongo: two writers from the same stale revision, only one wins', async () => {
    const registryRepository = new MongoAiModelRegistryRepository(db!)
    const registry = new AiModelRegistry(
      registryRepository,
      new MongoAiModelArtifactRepository(db!),
      fixedClock(),
    )
    await registry.startTraining(trainingLineage('revision-race'))
    const candidate = await registry.registerCandidate({
      modelVersion: 'revision-race',
      manifest: candidateManifest(),
      onnxBytes: realOnnxBytes,
      metricsBytes: realMetricsBytes,
    })

    const fromWriterA = candidate.beginEvaluation(AT)
    const fromWriterB = candidate.beginEvaluation(AT)

    await registryRepository.replaceWithExpectedRevision(fromWriterA, candidate.revision)
    await expect(
      registryRepository.replaceWithExpectedRevision(fromWriterB, candidate.revision),
    ).rejects.toBeInstanceOf(ModelVersionConflictError)
  })

  it('a direct insert bypassing the domain (invalid state string) is rejected by the Mongo validator', async () => {
    await expect(
      db!.collection(AI_MODEL_VERSIONS_COLLECTION).insertOne({
        _id: 'direct-insert-invalid',
        schemaVersion: 1,
        state: 'NOT_A_REAL_STATE',
        revision: 0,
        trainingLineage: trainingLineage('direct-insert-invalid'),
        artifactLineage: null,
        stateHistory: [{ from: null, to: 'TRAINING', at: AT }],
        rejection: null,
        createdAt: AT,
        updatedAt: AT,
      } as never),
    ).rejects.toMatchObject({ code: 121 })
  })

  it('a direct insert with an oversized/invalid sha256 field is rejected by the Mongo validator', async () => {
    await expect(
      db!.collection(AI_MODEL_VERSIONS_COLLECTION).insertOne({
        _id: 'direct-insert-bad-hash',
        schemaVersion: 1,
        state: 'TRAINING',
        revision: 0,
        trainingLineage: {
          ...trainingLineage('direct-insert-bad-hash'),
          trainingConfigSha256: 'not-a-hash',
        },
        artifactLineage: null,
        stateHistory: [{ from: null, to: 'TRAINING', at: AT }],
        rejection: null,
        createdAt: AT,
        updatedAt: AT,
      } as never),
    ).rejects.toMatchObject({ code: 121 })
  })
})
