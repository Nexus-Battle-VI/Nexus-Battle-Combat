import { MongoAiEvaluationCoordinatorRepository } from '../../adapters/outbound/persistence/MongoAiEvaluationCoordinatorRepository'
import { MongoAiModelArtifactRepository } from '../../adapters/outbound/persistence/MongoAiModelArtifactRepository'
import { MongoAiModelRegistryRepository } from '../../adapters/outbound/persistence/MongoAiModelRegistryRepository'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { AiModelRegistry } from '../../application/services/AiModelRegistry'
import { RollbackActiveModel } from '../../application/services/RollbackActiveModel'
import { loadConfig } from '../config/env'
import { createLogger } from '../observability/logger'
import { describeError } from '../observability/describe-error'
import { createMongoClient, databaseOf, DEFAULT_DATABASE_NAME } from '../persistence/database'

interface RollbackArgs {
  readonly databaseName: string
  readonly operationId: string
  readonly targetVersion: string
  readonly reason: string
}

const requireValue = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index + 1]
  if (value === undefined) throw new Error(`Falta el valor de "${flag}".`)
  return value
}

export const parseRollbackArgs = (argv: readonly string[]): RollbackArgs => {
  let databaseName = DEFAULT_DATABASE_NAME
  let operationId: string | null = null
  let targetVersion: string | null = null
  let reason: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    switch (flag) {
      case '--database-name':
        databaseName = requireValue(argv, index, flag)
        index += 1
        break
      case '--operation-id':
        operationId = requireValue(argv, index, flag)
        index += 1
        break
      case '--target-version':
        targetVersion = requireValue(argv, index, flag)
        index += 1
        break
      case '--reason':
        reason = requireValue(argv, index, flag)
        index += 1
        break
      default:
        throw new Error(`Flag desconocida: "${String(flag)}".`)
    }
  }

  if (operationId === null) throw new Error('--operation-id es obligatorio.')
  if (targetVersion === null) throw new Error('--target-version es obligatorio.')
  if (reason === null) throw new Error('--reason es obligatorio.')
  return { databaseName, operationId, targetVersion, reason }
}

export const runRollbackCli = async (argv: readonly string[]): Promise<void> => {
  const args = parseRollbackArgs(argv)
  const appConfig = loadConfig(process.env)
  if (appConfig.databaseUrl === null) throw new Error('MONGODB_URI es obligatorio para rollback.')
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
  const registry = new AiModelRegistry(new MongoAiModelRegistryRepository(db), artifacts, clock)
  const rollback = new RollbackActiveModel(
    registry,
    new MongoAiEvaluationCoordinatorRepository(db),
    clock,
    logger,
  )
  try {
    await rollback.execute(args)
  } finally {
    await client.close()
  }
}

if (require.main === module) {
  runRollbackCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`)
    process.exitCode = 1
  })
}
