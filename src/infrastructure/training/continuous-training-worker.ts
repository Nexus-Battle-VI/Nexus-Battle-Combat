import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import { loadConfig } from '../config/env'
import { createLogger } from '../observability/logger'
import { describeError } from '../observability/describe-error'
import { createMongoClient, databaseOf, DEFAULT_DATABASE_NAME } from '../persistence/database'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { MongoBattleRoomRepository } from '../../adapters/outbound/persistence/MongoBattleRoomRepository'
import { MongoAiModelRegistryRepository } from '../../adapters/outbound/persistence/MongoAiModelRegistryRepository'
import { MongoAiModelArtifactRepository } from '../../adapters/outbound/persistence/MongoAiModelArtifactRepository'
import { MongoContinuousTrainingCoordinatorRepository } from '../../adapters/outbound/persistence/MongoContinuousTrainingCoordinatorRepository'
import { AiModelRegistry } from '../../application/services/AiModelRegistry'
import { spawnChildProcess } from './ChildProcessRunner'
import {
  defaultWorkRootDir,
  generateOwnerId,
  runContinuousTrainingIteration,
  type ContinuousTrainingPipelineConfig,
  type ContinuousTrainingPipelineDeps,
} from './ContinuousTrainingPipeline'

/**
 * `npm run train:continuous` (EN-037.2, Management #571 §10): proceso
 * standalone, independiente del arranque HTTP de Combat -- mismo criterio
 * que `migrate.ts`/`run-ai-evaluation.ts`. Nunca se registra en
 * `app.module.ts`: entrenar no es una responsabilidad de ese proceso, y
 * levantarlo desde ahi haria que cada replica de Combat intentara
 * coordinar un lease a la vez sin necesidad.
 */

interface CliArgs {
  readonly once: boolean
  readonly maxIterations: number | null
  readonly aiDir: string
  readonly databaseName: string
  readonly pythonCommand: string
  readonly datasetSeed: number
  readonly trainingSeed: number
  readonly sourceCommit: string | null
  readonly gracePeriodMs: number
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly pollIntervalMs: number
  readonly datasetBuildTimeoutMs: number
  readonly trainingTimeoutMs: number
  readonly identityTimeoutMs: number
  readonly workRootDir: string
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
  readonly maxNotTrainableRetries: number
  readonly allowMissingLabels: boolean
}

const requireValue = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index + 1]
  if (value === undefined) throw new Error(`Falta el valor de "${flag}".`)
  return value
}

// En tiempo de ejecucion `__dirname` es `dist/infrastructure/training`
// (3 niveles bajo la raiz del repo): subir 3 llega a la raiz, donde vive `ai/`.
const DEFAULT_AI_DIR = resolve(__dirname, '../../../ai')

const parseArgs = (argv: readonly string[]): CliArgs => {
  let once = false
  let maxIterations: number | null = null
  let aiDir = DEFAULT_AI_DIR
  let databaseName = DEFAULT_DATABASE_NAME
  let pythonCommand = 'uv'
  let datasetSeed = 42
  let trainingSeed = 42
  let sourceCommit: string | null = null
  let gracePeriodMs = 5 * 60_000
  let leaseDurationMs = 15 * 60_000
  let heartbeatIntervalMs = 60_000
  let pollIntervalMs = 30_000
  let datasetBuildTimeoutMs = 10 * 60_000
  let trainingTimeoutMs = 30 * 60_000
  let identityTimeoutMs = 2 * 60_000
  let workRootDir = join(defaultWorkRootDir(), 'nexus-combat-continuous-training')
  let backoffBaseMs = 30_000
  let backoffMaxMs = 30 * 60_000
  let maxNotTrainableRetries = 3
  let allowMissingLabels = false

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    switch (flag) {
      case '--once':
        once = true
        break
      case '--max-iterations':
        maxIterations = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--ai-dir':
        aiDir = requireValue(argv, i, flag)
        i += 1
        break
      case '--database-name':
        databaseName = requireValue(argv, i, flag)
        i += 1
        break
      case '--python-command':
        pythonCommand = requireValue(argv, i, flag)
        i += 1
        break
      case '--dataset-seed':
        datasetSeed = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--training-seed':
        trainingSeed = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--source-commit':
        sourceCommit = requireValue(argv, i, flag)
        i += 1
        break
      case '--grace-period-ms':
        gracePeriodMs = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--lease-duration-ms':
        leaseDurationMs = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--heartbeat-interval-ms':
        heartbeatIntervalMs = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--poll-interval-ms':
        pollIntervalMs = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--dataset-build-timeout-ms':
        datasetBuildTimeoutMs = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--training-timeout-ms':
        trainingTimeoutMs = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--identity-timeout-ms':
        identityTimeoutMs = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--work-root-dir':
        workRootDir = requireValue(argv, i, flag)
        i += 1
        break
      case '--backoff-base-ms':
        backoffBaseMs = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--backoff-max-ms':
        backoffMaxMs = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--max-not-trainable-retries':
        maxNotTrainableRetries = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--allow-missing-labels':
        allowMissingLabels = true
        break
      default:
        throw new Error(`Flag desconocida: "${String(flag)}".`)
    }
  }

  if (heartbeatIntervalMs * 3 >= leaseDurationMs) {
    throw new Error(
      '--heartbeat-interval-ms debe ser bastante menor que --lease-duration-ms ' +
        '(al menos 3 latidos antes de que el lease expire).',
    )
  }

  return {
    once,
    maxIterations,
    aiDir,
    databaseName,
    pythonCommand,
    datasetSeed,
    trainingSeed,
    sourceCommit,
    gracePeriodMs,
    leaseDurationMs,
    heartbeatIntervalMs,
    pollIntervalMs,
    datasetBuildTimeoutMs,
    trainingTimeoutMs,
    identityTimeoutMs,
    workRootDir,
    backoffBaseMs,
    backoffMaxMs,
    maxNotTrainableRetries,
    allowMissingLabels,
  }
}

const backoffDelayMs = (consecutiveFailureCount: number, base: number, max: number): number =>
  Math.min(base * 2 ** Math.max(0, consecutiveFailureCount - 1), max)

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

const resolveSourceCommit = (args: CliArgs): string => {
  if (args.sourceCommit !== null) return args.sourceCommit
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
  } catch (error) {
    throw new Error(
      `No se pudo determinar --source-commit (sin la flag y sin "git rev-parse HEAD" disponible): ${describeError(error)}`,
      { cause: error },
    )
  }
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const appConfig = loadConfig(process.env)
  const logger = createLogger({
    level: appConfig.logLevel,
    service: appConfig.serviceName,
    version: appConfig.version,
  })

  if (appConfig.databaseUrl === null) {
    throw new Error('MONGODB_URI es obligatorio para el worker de reentrenamiento continuo.')
  }

  const sourceCommit = resolveSourceCommit(args)
  const options = { uri: appConfig.databaseUrl, databaseName: args.databaseName }
  const client = createMongoClient(options)
  await client.connect()
  const db = databaseOf(client, options)

  const pipelineConfig: ContinuousTrainingPipelineConfig = {
    ownerId: generateOwnerId(),
    aiDir: args.aiDir,
    pythonCommand: args.pythonCommand,
    mongoUri: appConfig.databaseUrl,
    databaseName: args.databaseName,
    datasetSeed: args.datasetSeed,
    trainingSeed: args.trainingSeed,
    sourceCommit,
    gracePeriodMs: args.gracePeriodMs,
    leaseDurationMs: args.leaseDurationMs,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    datasetBuildTimeoutMs: args.datasetBuildTimeoutMs,
    trainingTimeoutMs: args.trainingTimeoutMs,
    identityTimeoutMs: args.identityTimeoutMs,
    workRootDir: args.workRootDir,
    maxNotTrainableRetries: args.maxNotTrainableRetries,
    allowMissingLabels: args.allowMissingLabels,
  }

  const deps: ContinuousTrainingPipelineDeps = {
    battleRooms: new MongoBattleRoomRepository(db),
    coordinator: new MongoContinuousTrainingCoordinatorRepository(db),
    registry: new AiModelRegistry(
      new MongoAiModelRegistryRepository(db),
      new MongoAiModelArtifactRepository(db),
      new SystemClock(),
    ),
    clock: new SystemClock(),
    logger,
    runChildProcess: spawnChildProcess,
  }

  logger.info('continuous_training_worker_started', {
    ownerId: pipelineConfig.ownerId,
    aiDir: pipelineConfig.aiDir,
    once: args.once,
  })

  // Objeto mutable, no un `let boolean` (mismo motivo que `leaseLostRef` en
  // `ContinuousTrainingPipeline.ts`): lo escribe un manejador de senal
  // async, y TypeScript angostaria un primitivo a "siempre false" en el
  // `while` de mas abajo.
  const shuttingDownRef: { current: boolean } = { current: false }
  const requestShutdown = (signal: string): void => {
    logger.info('continuous_training_worker_shutdown_requested', { signal })
    shuttingDownRef.current = true
  }
  process.on('SIGINT', () => {
    requestShutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    requestShutdown('SIGTERM')
  })

  let scanWatermark = (await deps.coordinator.getSnapshot()).requestedThrough
  let iterations = 0

  try {
    do {
      const { outcome, nextScanWatermark } = await runContinuousTrainingIteration(
        deps,
        pipelineConfig,
        scanWatermark,
      )
      scanWatermark = nextScanWatermark
      iterations += 1

      switch (outcome.kind) {
        case 'IDLE':
          if (!args.once) await sleep(args.pollIntervalMs)
          break
        case 'LEASE_BUSY':
          if (!args.once) await sleep(args.pollIntervalMs)
          break
        case 'NOT_TRAINABLE':
          logger.info('continuous_training_iteration_not_trainable', { reason: outcome.reason })
          break
        case 'SUCCESS':
          logger.info('continuous_training_iteration_success', {
            modelVersion: outcome.modelVersion,
          })
          break
        case 'FAILED': {
          logger.error('continuous_training_iteration_failed', {
            reasonCode: outcome.reasonCode,
            reason: outcome.reason,
          })
          if (!args.once) {
            const snapshot = await deps.coordinator.getSnapshot()
            await sleep(
              backoffDelayMs(
                snapshot.consecutiveFailureCount,
                args.backoffBaseMs,
                args.backoffMaxMs,
              ),
            )
          }
          break
        }
      }
    } while (
      !args.once &&
      !shuttingDownRef.current &&
      (args.maxIterations === null || iterations < args.maxIterations)
    )
  } finally {
    await client.close()
  }

  logger.info('continuous_training_worker_stopped', { iterations })
}

main().catch((error: unknown) => {
  process.stderr.write(`${describeError(error)}\n`)
  process.exitCode = 1
})
