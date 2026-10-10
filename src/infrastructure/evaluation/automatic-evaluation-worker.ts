import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { MongoAiEvaluationCoordinatorRepository } from '../../adapters/outbound/persistence/MongoAiEvaluationCoordinatorRepository'
import { MongoAiModelArtifactRepository } from '../../adapters/outbound/persistence/MongoAiModelArtifactRepository'
import { MongoAiModelRegistryRepository } from '../../adapters/outbound/persistence/MongoAiModelRegistryRepository'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { AiModelRegistry } from '../../application/services/AiModelRegistry'
import { loadConfig } from '../config/env'
import { createLogger } from '../observability/logger'
import { describeError } from '../observability/describe-error'
import { createMongoClient, databaseOf, DEFAULT_DATABASE_NAME } from '../persistence/database'
import {
  defaultEvaluationWorkRootDir,
  processNextAutomaticEvaluation,
  type AutomaticModelEvaluationCoordinatorConfig,
} from './AutomaticModelEvaluationCoordinator'
import { runAiEvaluation } from './run-ai-evaluation'

interface CliArgs {
  readonly once: boolean
  readonly maxIterations: number | null
  readonly databaseName: string
  readonly pollIntervalMs: number
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly seedStart: number
  readonly seedCount: number
  readonly mctsSeedCount: number
  readonly maxPlies: number
  readonly sourceCommit: string | null
  readonly skipExpensiveMcts: boolean
  readonly workRootDir: string
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
}

const valueAfter = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index + 1]
  if (value === undefined) throw new Error(`Falta el valor de "${flag}".`)
  return value
}

export const parseAutomaticEvaluationArgs = (argv: readonly string[]): CliArgs => {
  let once = false
  let maxIterations: number | null = null
  let databaseName = DEFAULT_DATABASE_NAME
  let pollIntervalMs = 30_000
  let leaseDurationMs = 30 * 60_000
  let heartbeatIntervalMs = 60_000
  let seedStart = 3_000_000
  let seedCount = 50
  let mctsSeedCount = 10
  let maxPlies = 500
  let sourceCommit: string | null = null
  let skipExpensiveMcts = false
  let workRootDir = defaultEvaluationWorkRootDir()
  let backoffBaseMs = 30_000
  let backoffMaxMs = 30 * 60_000

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    switch (flag) {
      case '--once':
        once = true
        break
      case '--max-iterations':
        maxIterations = Number(valueAfter(argv, index, flag))
        index += 1
        break
      case '--database-name':
        databaseName = valueAfter(argv, index, flag)
        index += 1
        break
      case '--poll-interval-ms':
        pollIntervalMs = Number(valueAfter(argv, index, flag))
        index += 1
        break
      case '--lease-duration-ms':
        leaseDurationMs = Number(valueAfter(argv, index, flag))
        index += 1
        break
      case '--heartbeat-interval-ms':
        heartbeatIntervalMs = Number(valueAfter(argv, index, flag))
        index += 1
        break
      case '--seed-start':
        seedStart = Number(valueAfter(argv, index, flag))
        index += 1
        break
      case '--seed-count':
        seedCount = Number(valueAfter(argv, index, flag))
        index += 1
        break
      case '--mcts-seed-count':
        mctsSeedCount = Number(valueAfter(argv, index, flag))
        index += 1
        break
      case '--max-plies':
        maxPlies = Number(valueAfter(argv, index, flag))
        index += 1
        break
      case '--source-commit':
        sourceCommit = valueAfter(argv, index, flag)
        index += 1
        break
      case '--skip-expensive-mcts':
        skipExpensiveMcts = true
        break
      case '--work-root-dir':
        workRootDir = valueAfter(argv, index, flag)
        index += 1
        break
      case '--backoff-base-ms':
        backoffBaseMs = Number(valueAfter(argv, index, flag))
        index += 1
        break
      case '--backoff-max-ms':
        backoffMaxMs = Number(valueAfter(argv, index, flag))
        index += 1
        break
      default:
        throw new Error(`Flag desconocida: "${String(flag)}".`)
    }
  }

  const positiveIntegers = {
    pollIntervalMs,
    leaseDurationMs,
    heartbeatIntervalMs,
    seedCount,
    mctsSeedCount,
    maxPlies,
    backoffBaseMs,
    backoffMaxMs,
  }
  for (const [name, value] of Object.entries(positiveIntegers)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} debe ser entero positivo.`)
  }
  if (!Number.isInteger(seedStart) || seedStart < 0 || seedStart > 0xffff_ffff) {
    throw new Error('seedStart debe ser un uint32.')
  }
  if (heartbeatIntervalMs * 3 >= leaseDurationMs) {
    throw new Error('heartbeatIntervalMs debe permitir al menos tres latidos por lease.')
  }
  if (maxIterations !== null && (!Number.isInteger(maxIterations) || maxIterations <= 0)) {
    throw new Error('maxIterations debe ser entero positivo.')
  }

  return {
    once,
    maxIterations,
    databaseName,
    pollIntervalMs,
    leaseDurationMs,
    heartbeatIntervalMs,
    seedStart,
    seedCount,
    mctsSeedCount,
    maxPlies,
    sourceCommit,
    skipExpensiveMcts,
    workRootDir,
    backoffBaseMs,
    backoffMaxMs,
  }
}

const sourceCommitOf = (explicit: string | null): string =>
  explicit ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

export const runAutomaticEvaluationWorker = async (argv: readonly string[]): Promise<void> => {
  const args = parseAutomaticEvaluationArgs(argv)
  const appConfig = loadConfig(process.env)
  if (appConfig.databaseUrl === null) {
    throw new Error('MONGODB_URI es obligatorio para el worker de evaluacion automatica.')
  }
  const logger = createLogger({
    level: appConfig.logLevel,
    service: appConfig.serviceName,
    version: appConfig.version,
  })
  const options = { uri: appConfig.databaseUrl, databaseName: args.databaseName }
  const client = createMongoClient(options)
  await client.connect()
  const db = databaseOf(client, options)
  const clock = new SystemClock()
  const artifacts = new MongoAiModelArtifactRepository(db)
  const ledger = new MongoAiEvaluationCoordinatorRepository(db)
  const deps = {
    registry: new AiModelRegistry(new MongoAiModelRegistryRepository(db), artifacts, clock),
    ledger,
    artifactRepository: artifacts,
    clock,
    logger,
    runEvaluation: runAiEvaluation,
  }
  const config: AutomaticModelEvaluationCoordinatorConfig = {
    ownerId: `${hostname()}:${String(process.pid)}:${randomUUID()}`,
    leaseDurationMs: args.leaseDurationMs,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    workRootDir: args.workRootDir,
    seedStart: args.seedStart,
    seedCount: args.seedCount,
    mctsSeedCount: args.mctsSeedCount,
    maxPlies: args.maxPlies,
    sourceCommit: sourceCommitOf(args.sourceCommit),
    skipExpensiveMcts: args.skipExpensiveMcts,
  }
  let iterations = 0
  const shutdown = { requested: false }
  const requestShutdown = (signal: string): void => {
    shutdown.requested = true
    logger.info('automatic_evaluation_worker_shutdown_requested', { signal })
  }
  process.on('SIGINT', () => {
    requestShutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    requestShutdown('SIGTERM')
  })
  logger.info('automatic_evaluation_worker_started', {
    ownerId: config.ownerId,
    once: args.once,
  })

  try {
    do {
      const outcome = await processNextAutomaticEvaluation(deps, config)
      iterations += 1
      if (outcome.kind === 'IDLE' || outcome.kind === 'LEASE_BUSY') {
        if (!args.once) await sleep(args.pollIntervalMs)
      } else if (outcome.kind === 'INFRASTRUCTURE_FAILURE' && !args.once) {
        const snapshot = await ledger.getByModelVersion(outcome.modelVersion)
        const failures = snapshot?.consecutiveFailureCount ?? 1
        await sleep(
          Math.min(args.backoffBaseMs * 2 ** Math.max(0, failures - 1), args.backoffMaxMs),
        )
      }
    } while (
      !args.once &&
      !shutdown.requested &&
      (args.maxIterations === null || iterations < args.maxIterations)
    )
  } finally {
    await client.close()
  }
  logger.info('automatic_evaluation_worker_stopped', { iterations })
}

if (require.main === module) {
  runAutomaticEvaluationWorker(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`)
    process.exitCode = 1
  })
}
