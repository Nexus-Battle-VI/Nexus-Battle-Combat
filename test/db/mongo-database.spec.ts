import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
  pingDatabase,
  type MongoMigration,
} from '../../src/infrastructure/persistence/database'

/**
 * Infraestructura de persistencia contra un MongoDB REAL.
 *
 * Lo que se comprueba no se puede comprobar con un doble: que el cliente
 * conecta, que la reclamacion de migraciones da exclusion mutua con la unicidad
 * de `_id`, y que una migracion rota o a medias se informa.
 *
 * `MONGO_TEST_URI` permite usar un motor existente en lugar de Testcontainers.
 */
describe('Persistencia MongoDB', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    const externalUri = process.env.MONGO_TEST_URI
    if (externalUri === undefined) container = await new MongoDBContainer('mongo:8.0').start()
    const uri = externalUri ?? `${container!.getConnectionString()}?directConnection=true`
    const options = { uri, databaseName: `test_combat_${String(Date.now())}` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
  }, 120_000)

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
    await container?.stop()
  })

  it('la sonda responde contra un motor disponible', async () => {
    await expect(pingDatabase(db)).resolves.toBe(true)
  })

  it('aplica las migraciones del producto sin error', async () => {
    const outcome = await migrateToLatest(db)

    expect(outcome.error).toBeUndefined()
  })

  it('registra las migraciones aplicadas y no las repite', async () => {
    let ejecuciones = 0
    const migrations: MongoMigration[] = [
      {
        name: '900-prueba',
        up: async (conexion) => {
          ejecuciones += 1
          await conexion.createCollection('prueba')
        },
      },
    ]

    expect((await migrateToLatest(db, migrations)).applied).toEqual(['900-prueba'])
    expect((await migrateToLatest(db, migrations)).applied).toEqual([])
    expect(ejecuciones).toBe(1)
    expect(await db.listCollections({ name: 'prueba' }).hasNext()).toBe(true)
  })

  it('retira la reclamacion de una migracion rota para permitir el reintento', async () => {
    const rota: MongoMigration = { name: '901-rota', up: () => Promise.reject(new Error('fallo')) }

    const outcome = await migrateToLatest(db, [rota])

    expect(outcome.applied).toEqual([])
    expect(outcome.error).toBeInstanceOf(Error)
    expect(await db.collection('_migrations').countDocuments({ _id: '901-rota' as never })).toBe(0)
  })

  it('se niega a continuar sobre una migracion que quedo a medias', async () => {
    await db
      .collection('_migrations')
      .insertOne({ _id: '902-a-medias' as never, startedAt: new Date() })

    const outcome = await migrateToLatest(db, [
      { name: '902-a-medias', up: () => Promise.resolve() },
    ])

    expect(outcome.error).toBeInstanceOf(Error)
    expect(String(outcome.error)).toContain('902-a-medias')
  })

  /**
   * El control de la primera prueba: con el motor inalcanzable la sonda dice
   * `false`. Sin este caso, una sonda que devolviera siempre `true` pasaria.
   */
  it('la sonda falla contra un motor inalcanzable', async () => {
    const options = { uri: 'mongodb://127.0.0.1:1', serverSelectionTimeoutMS: 500 }
    const inalcanzable = createMongoClient(options)

    try {
      await expect(pingDatabase(databaseOf(inalcanzable, options))).resolves.toBe(false)
    } finally {
      await inalcanzable.close()
    }
  })
})
