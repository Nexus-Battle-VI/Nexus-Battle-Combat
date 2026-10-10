import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { AiModelRegistry } from '../../src/application/services/AiModelRegistry'
import { MongoAiModelRegistryRepository } from '../../src/adapters/outbound/persistence/MongoAiModelRegistryRepository'
import { MongoAiModelArtifactRepository } from '../../src/adapters/outbound/persistence/MongoAiModelArtifactRepository'
import { MongoBattleRoomRepository } from '../../src/adapters/outbound/persistence/MongoBattleRoomRepository'
import { MongoContinuousTrainingCoordinatorRepository } from '../../src/adapters/outbound/persistence/MongoContinuousTrainingCoordinatorRepository'
import { spawnChildProcess } from '../../src/infrastructure/training/ChildProcessRunner'
import {
  generateOwnerId,
  runContinuousTrainingIteration,
  type ContinuousTrainingPipelineConfig,
  type ContinuousTrainingPipelineDeps,
} from '../../src/infrastructure/training/ContinuousTrainingPipeline'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { inBattleRoom, silentLogger } from '../fixtures/battle'

const AI_DIR = resolve(__dirname, '../../ai')
const FIXTURES_DIR = join(AI_DIR, 'tests', 'fixtures', 'training')

/** Todos los eventos del fixture ocurren el 2026-09-10; esto esta comodamente despues. */
const FINISHED_AT = new Date('2026-09-15T00:00:00.000Z')
/** Un poco despues de `FINISHED_AT` + el periodo de gracia (1s) de esta prueba. */
const NOW = new Date('2026-09-15T00:00:10.000Z')
const fixedClock = { now: () => NOW }
const GRACE_PERIOD_MS = 1_000
/**
 * `cutoff = min(requestedThrough + gracePeriodMs, startedAt)`
 * (`ContinuousTrainingPipeline.ts::runContinuousTrainingIteration`): el
 * cutoff -- y por tanto `processedThrough` tras `recordSuccess` -- NUNCA es
 * el `finishedAt` crudo de la battle room, siempre se le suma el periodo de
 * gracia configurado (revision de codigo EN-037.5, Management #574: esta
 * asercion comparaba contra `FINISHED_AT` sin ese margen, un desajuste que
 * nunca se detecto en CI porque este archivo se omite alli sin `uv`/Python).
 */
const EXPECTED_CUTOFF = new Date(FINISHED_AT.getTime() + GRACE_PERIOD_MS)

const readJsonlDocuments = async (path: string): Promise<readonly Record<string, unknown>[]> => {
  const raw = await readFile(path, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Mismo mapeo que `combat-decision-event-mapping.ts`/la coleccion real
 * (#571, prueba integrada §G): `eventId`/`generatedAt`/`occurredAt` son
 * campos reales de la coleccion, nunca inventados aqui.
 */
const toDecisionEventDocument = (line: Record<string, unknown>): Record<string, unknown> => {
  const { eventId, occurredAt, ...rest } = line
  return { _id: eventId, ...rest, occurredAt: new Date(occurredAt as string) }
}

const toTeacherLabelDocument = (line: Record<string, unknown>): Record<string, unknown> => {
  const { eventId, generatedAt, ...rest } = line
  return { _id: eventId, ...rest, generatedAt: new Date(generatedAt as string) }
}

/**
 * El job "Calidad y pruebas" (Node, `test:db`) NO instala `uv`/Python a
 * proposito -- es un job aislado del pipeline Python (`ai/` tiene su
 * propio job `Pipeline de dataset y entrenamiento IA`, ver `ci.yml`).
 * Esta prueba necesita AMBOS stacks a la vez, asi que se omite
 * (`describe.skip`, nunca "paso sin ejecutarse") cuando `uv` no esta en
 * PATH, en vez de fallar por un ENOENT de infraestructura que no es un
 * defecto del codigo. Corre completa en local y en cualquier entorno que
 * si tenga ambos stacks.
 */
const isUvAvailable = (): boolean => {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Prueba integrada de punta a punta (EN-037.2, Management #571 §12.G):
 * MongoDB REAL + Python REAL (`uv run nexus-combat-dataset`/`nexus-combat-train`,
 * nunca mockeado) + `AiModelRegistry` REAL -> una version `CANDIDATE` real.
 *
 * Los eventos de decision/labels son el fixture CONTROLADO
 * `ai/tests/fixtures/training/{decision-events,teacher-labels}.jsonl` (el
 * mismo que ya usan las pruebas Python de #567/#568) -- honesto: NO es
 * telemetria de jugadores reales, es sintetico pero con la FORMA real del
 * contrato (migraciones 023/025). El mecanismo que se demuestra (senal
 * durable -> lease -> dataset -> training -> ONNX -> registry -> CANDIDATE)
 * es real de punta a punta; los datos de entrada estan etiquetados como lo
 * que son.
 */
;(isUvAvailable() ? describe : describe.skip)(
  'Worker de reentrenamiento continuo de punta a punta (EN-037.2, Management #571)',
  () => {
    let container: StartedMongoDBContainer | undefined
    let client: MongoClient | undefined
    let db: Db | undefined
    let mongoUri = ''
    let databaseName = ''

    beforeAll(async () => {
      const externalUri = process.env.MONGO_TEST_URI
      if (externalUri === undefined) container = await new MongoDBContainer('mongo:8.0').start()
      const options = {
        uri: externalUri ?? `${container!.getConnectionString()}/?directConnection=true`,
        databaseName: `continuous_training_e2e_${String(Date.now())}`,
      }
      mongoUri = options.uri
      databaseName = options.databaseName
      client = createMongoClient(options)
      await client.connect()
      db = databaseOf(client, options)
      const outcome = await migrateToLatest(db)
      if (outcome.error !== undefined) {
        throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
      }

      const decisionEvents = await readJsonlDocuments(join(FIXTURES_DIR, 'decision-events.jsonl'))
      const teacherLabels = await readJsonlDocuments(join(FIXTURES_DIR, 'teacher-labels.jsonl'))
      await db
        .collection('combat-decision-events')
        .insertMany(decisionEvents.map(toDecisionEventDocument))
      await db
        .collection('mcts-teacher-labels')
        .insertMany(teacherLabels.map(toTeacherLabelDocument))

      const battleRooms = new MongoBattleRoomRepository(db)
      const finishedRoom = inBattleRoom().finish(
        { reason: 'ELIMINATION', winnerTeamLabel: 'A' },
        FINISHED_AT,
      )
      await battleRooms.save(finishedRoom, 0)
    }, 180_000)

    afterAll(async () => {
      await db?.dropDatabase()
      await client?.close()
      await container?.stop()
    })

    it('advances the cursor, claims the lease, builds the dataset, trains with REAL PyTorch, and registers a REAL CANDIDATE', async () => {
      const workRootDir = await mkdtemp(join(tmpdir(), 'ai-continuous-training-e2e-'))

      const config: ContinuousTrainingPipelineConfig = {
        ownerId: generateOwnerId(),
        aiDir: AI_DIR,
        pythonCommand: 'uv',
        mongoUri,
        databaseName,
        datasetSeed: 42,
        trainingSeed: 7,
        sourceCommit: 'continuous-training-e2e-test',
        gracePeriodMs: GRACE_PERIOD_MS,
        leaseDurationMs: 5 * 60_000,
        heartbeatIntervalMs: 20_000,
        datasetBuildTimeoutMs: 90_000,
        trainingTimeoutMs: 180_000,
        identityTimeoutMs: 90_000,
        workRootDir,
        maxNotTrainableRetries: 3,
      }

      const deps: ContinuousTrainingPipelineDeps = {
        battleRooms: new MongoBattleRoomRepository(db!),
        coordinator: new MongoContinuousTrainingCoordinatorRepository(db!),
        registry: new AiModelRegistry(
          new MongoAiModelRegistryRepository(db!),
          new MongoAiModelArtifactRepository(db!),
          fixedClock,
        ),
        clock: fixedClock,
        logger: silentLogger,
        runChildProcess: spawnChildProcess,
      }

      const { outcome } = await runContinuousTrainingIteration(deps, config, new Date(0))

      if (outcome.kind !== 'SUCCESS') {
        throw new Error(`Se esperaba SUCCESS, se obtuvo: ${JSON.stringify(outcome)}`)
      }

      const registered = await deps.registry.findByVersion(outcome.modelVersion)
      expect(registered?.state).toBe('CANDIDATE')
      expect(registered?.artifactLineage?.artifactPurpose).toBe('CANDIDATE')
      expect(registered?.trainingLineage.trainingSeed).toBe(7)
      expect(registered?.trainingLineage.datasetSeed).toBe(42)

      const artifactRepository = new MongoAiModelArtifactRepository(db!)
      const artifact = await artifactRepository.getBySha256(
        registered!.artifactLineage!.onnxArtifactSha256,
      )
      expect(artifact).not.toBeNull()
      expect(artifact!.sizeBytes).toBeGreaterThan(0)

      const snapshot = await deps.coordinator.getSnapshot()
      expect(snapshot.leaseState).toBe('IDLE')
      expect(snapshot.lastRunOutcome).toBe('SUCCESS')
      expect(snapshot.lastRunModelVersion).toBe(outcome.modelVersion)
      expect(snapshot.processedThrough).toEqual(EXPECTED_CUTOFF)
    }, 420_000)
  },
)
