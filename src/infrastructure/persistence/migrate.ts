import { loadConfig } from '../config/env'
import { createLogger } from '../observability/logger'
import { describeError } from '../observability/describe-error'
import { createMongoClient, databaseOf, migrateToLatest } from './database'

/**
 * Punto de entrada de `npm run migrate`.
 *
 * Es un paso explicito del despliegue y no algo que ocurra al arrancar el
 * servicio: migrar desde el arranque hace que varias replicas migren a la vez, y
 * que un despliegue con una migracion rota deje el servicio en bucle de
 * reinicio en lugar de fallar una sola vez, de forma visible.
 */
const main = async (): Promise<void> => {
  const config = loadConfig(process.env)
  const logger = createLogger({
    level: config.logLevel,
    service: config.serviceName,
    version: config.version,
  })

  if (config.databaseUrl === null) {
    throw new Error('MONGODB_URI es obligatorio para ejecutar las migraciones.')
  }

  const options = { uri: config.databaseUrl }
  const client = createMongoClient(options)

  try {
    await client.connect()

    const { applied, error } = await migrateToLatest(databaseOf(client, options))

    for (const name of applied) {
      logger.info('migration_applied', { migration: name })
    }

    if (error !== undefined) {
      throw new Error(`La migracion fallo: ${describeError(error)}`)
    }

    logger.info('migrations_up_to_date', { applied: applied.length })
  } finally {
    // Sin esto el proceso no termina: el cliente mantiene vivo el bucle de
    // eventos con sus conexiones al motor.
    await client.close()
  }
}

main().catch((error: unknown) => {
  // El registro ya no esta disponible si la configuracion fue lo que fallo, asi
  // que este es el unico sitio donde escribir directamente esta justificado.
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
