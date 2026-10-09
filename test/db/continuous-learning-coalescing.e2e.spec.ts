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
import {
  spawnChildProcess,
  type ChildProcessRunner,
} from '../../src/infrastructure/training/ChildProcessRunner'
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

/** Mismo fixture que EN-037.2 (`continuous-training-worker-e2e.spec.ts`): todos sus eventos ocurren el 2026-09-10. */
const FINISHED_AT = new Date('2026-09-15T00:00:00.000Z')
const NOW = new Date('2026-09-15T00:00:10.000Z')
/** Dos "partidas nuevas" que llegan mientras el primer training esta en curso (EN-037.5, Escenario E2E-06/E2E-16). */
const LATE_ARRIVAL_A = new Date('2026-09-15T00:00:20.000Z')
const LATE_ARRIVAL_B = new Date('2026-09-15T00:00:30.000Z')
const LATE_ARRIVALS_NOW = new Date('2026-09-15T00:00:40.000Z')
const fixedClock = { now: () => NOW }
const GRACE_PERIOD_MS = 1_000
/** `cutoff = min(requestedThrough + gracePeriodMs, startedAt)` (`ContinuousTrainingPipeline.ts`): nunca el `finishedAt` crudo. */
const EXPECTED_CUTOFF = new Date(FINISHED_AT.getTime() + GRACE_PERIOD_MS)

const readJsonlDocuments = async (path: string): Promise<readonly Record<string, unknown>[]> => {
  const raw = await readFile(path, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const toDecisionEventDocument = (line: Record<string, unknown>): Record<string, unknown> => {
  const { eventId, occurredAt, ...rest } = line
  return { _id: eventId, ...rest, occurredAt: new Date(occurredAt as string) }
}

const toTeacherLabelDocument = (line: Record<string, unknown>): Record<string, unknown> => {
  const { eventId, generatedAt, ...rest } = line
  return { _id: eventId, ...rest, generatedAt: new Date(generatedAt as string) }
}

const isUvAvailable = (): boolean => {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * EN-037.5 (Management #574), Escenario E2E-06/E2E-16: mientras el PRIMER
 * training (claim de lease real, dataset REAL, PyTorch REAL) esta en curso,
 * dos partidas NUEVAS terminan y se persisten en Mongo real. Esta prueba
 * demuestra -- sobre el pipeline REAL, nunca una reimplementacion en memoria --
 * que:
 *
 * 1. El training en curso NUNCA incorpora esas partidas tardias en su propio
 *    cutoff (su CANDIDATE queda con la identidad/lineage del cutoff original).
 * 2. Ninguna partida nueva se pierde: `requestedThrough` las alcanza en la
 *    SIGUIENTE iteracion, nunca se salta por encima de ellas.
 * 3. No se dispara un segundo training CONCURRENTE (el lease de la primera
 *    iteracion ya se libero antes de que la segunda pueda reclamarlo).
 *
 * El "mientras tanto" se simula insertando las dos partidas tardias desde un
 * `ChildProcessRunner` que envuelve al real (`spawnChildProcess`, nunca
 * mockeado): justo antes de que el pipeline invoque el proceso Python de
 * ENTRENAMIENTO (nunca el de `--emit-identity-only`), que es el tramo mas
 * largo de una iteracion real, se escriben las dos partidas tardias. Esto
 * reproduce honestamente la condicion de carrera de produccion (el worker
 * sigue un solo hilo de iteracion; lo que varia es SOLO el momento relativo
 * de la escritura de Mongo, nunca la logica del pipeline bajo prueba).
 */
;(isUvAvailable() ? describe : describe.skip)(
  'Coalescing de partidas nuevas durante un training real en curso (EN-037.5, Management #574)',
  () => {
    let container: StartedMongoDBContainer | undefined
    let client: MongoClient | undefined
    let db: Db | undefined
    let mongoUri = ''
    let databaseName = ''
    let lateArrivalsInserted = false

    beforeAll(async () => {
      const externalUri = process.env.MONGO_TEST_URI
      if (externalUri === undefined) container = await new MongoDBContainer('mongo:8.0').start()
      const options = {
        uri: externalUri ?? `${container!.getConnectionString()}/?directConnection=true`,
        databaseName: `continuous_learning_coalescing_e2e_${String(Date.now())}`,
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

    /** Inserta las 2 partidas tardias UNA sola vez, justo antes del entrenamiento real. */
    const insertLateArrivalsOnce = async (): Promise<void> => {
      if (lateArrivalsInserted) return
      lateArrivalsInserted = true

      const battleRooms = new MongoBattleRoomRepository(db!)
      const lateA = inBattleRoom({ id: '22222222-2222-4222-8222-222222222222' }).finish(
        { reason: 'ELIMINATION', winnerTeamLabel: 'A' },
        LATE_ARRIVAL_A,
      )
      const lateB = inBattleRoom({ id: '33333333-3333-4333-8333-333333333333' }).finish(
        { reason: 'ELIMINATION', winnerTeamLabel: 'B' },
        LATE_ARRIVAL_B,
      )
      await battleRooms.save(lateA, 0)
      await battleRooms.save(lateB, 0)
    }

    /** Envuelve `spawnChildProcess` REAL -- nunca lo sustituye -- solo observa cuando arranca el entrenamiento real. */
    const interceptingRunner: ChildProcessRunner = (command, args, options) => {
      const isRealTraining =
        args.includes('nexus-combat-train') && args.includes('--artifact-purpose')
      if (isRealTraining) {
        // Fire-and-forget deliberado: estas 2 partidas deben llegar a Mongo
        // ANTES de que el proceso Python termine, nunca antes de que arranque.
        void insertLateArrivalsOnce()
      }
      return spawnChildProcess(command, args, options)
    }

    it('el training en curso ignora las partidas tardias; ninguna se pierde en la siguiente iteracion', async () => {
      const workRootDir = await mkdtemp(join(tmpdir(), 'ai-coalescing-e2e-'))

      const coordinator = new MongoContinuousTrainingCoordinatorRepository(db!)
      const registry = new AiModelRegistry(
        new MongoAiModelRegistryRepository(db!),
        new MongoAiModelArtifactRepository(db!),
        fixedClock,
      )
      const baseConfig: Omit<ContinuousTrainingPipelineConfig, 'ownerId'> = {
        aiDir: AI_DIR,
        pythonCommand: 'uv',
        mongoUri,
        databaseName,
        datasetSeed: 42,
        trainingSeed: 7,
        sourceCommit: 'continuous-learning-coalescing-e2e-test',
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
        coordinator,
        registry,
        clock: fixedClock,
        logger: silentLogger,
        runChildProcess: interceptingRunner,
      }

      const first = await runContinuousTrainingIteration(
        deps,
        { ...baseConfig, ownerId: generateOwnerId() },
        new Date(0),
      )

      if (first.outcome.kind !== 'SUCCESS') {
        throw new Error(
          `Se esperaba SUCCESS en la primera iteracion, se obtuvo: ${JSON.stringify(first.outcome)}`,
        )
      }
      expect(lateArrivalsInserted).toBe(true)

      const firstVersion = await registry.findByVersion(first.outcome.modelVersion)
      // El cutoff de la version entrenada es el de la PRIMERA partida unicamente
      // (#574 E2E-06): las dos tardias llegaron DESPUES de que el pipeline ya
      // habia fijado su `cutoff` para esta iteracion.
      expect(firstVersion?.trainingLineage.datasetCutoff).not.toBeUndefined()
      expect(new Date(firstVersion!.trainingLineage.datasetCutoff).getTime()).toBeLessThan(
        LATE_ARRIVAL_A.getTime(),
      )

      const afterFirst = await coordinator.getSnapshot()
      expect(afterFirst.leaseState).toBe('IDLE')
      expect(afterFirst.lastRunOutcome).toBe('SUCCESS')
      // Las 2 partidas tardias NO se incorporaron a `processedThrough` de esta
      // version: `processedThrough` sigue en el cutoff de la partida original
      // (`requestedThrough` + periodo de gracia, nunca el `finishedAt` crudo).
      expect(afterFirst.processedThrough).toEqual(EXPECTED_CUTOFF)

      // Segunda iteracion (clock avanzado, como un segundo tick real del
      // worker): debe DESCUBRIR las 2 partidas tardias -- nunca saltar por
      // encima de ellas -- avanzando `requestedThrough`.
      const secondClock = { now: () => LATE_ARRIVALS_NOW }
      const second = await runContinuousTrainingIteration(
        { ...deps, clock: secondClock, registry },
        { ...baseConfig, ownerId: generateOwnerId() },
        first.nextScanWatermark,
      )

      const afterSecond = await coordinator.getSnapshot()
      expect(afterSecond.requestedThrough.getTime()).toBeGreaterThanOrEqual(
        LATE_ARRIVAL_B.getTime(),
      )
      // Las 2 partidas tardias no tienen CombatDecisionEvent propio en este
      // fixture (son rooms sinteticas sin decisiones IA) -- el dataset para
      // su propio cutoff es honestamente NOT_TRAINABLE, nunca una candidata
      // fabricada. Lo que esta prueba demuestra es que LLEGARON a
      // `requestedThrough`, no que produjeron un segundo modelo.
      expect(['NOT_TRAINABLE', 'SUCCESS']).toContain(second.outcome.kind)
      if (second.outcome.kind === 'SUCCESS') {
        expect(second.outcome.modelVersion).not.toBe(first.outcome.modelVersion)
      }
    }, 420_000)
  },
)
