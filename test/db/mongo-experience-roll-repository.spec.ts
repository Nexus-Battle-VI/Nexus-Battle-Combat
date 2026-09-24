import 'reflect-metadata'

import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import {
  EXPERIENCE_ROLLS_COLLECTION,
  MongoExperienceRollRepository,
} from '../../src/adapters/outbound/persistence/MongoExperienceRollRepository'
import type { ExperienceRollBatchIntent } from '../../src/application/ports/ExperienceRollRepositoryPort'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

/**
 * Persistencia del lote de tiradas de experiencia (HU-09,
 * `hu-09-experience-reward-v1` §5.2) contra un MongoDB REAL, en contenedor.
 *
 * Lo que un doble no puede demostrar:
 *   - que la migracion `013` cree la coleccion y su validador `$jsonSchema`;
 *   - que el lote sea UN SOLO documento con las derrotas dentro;
 *   - que la exclusion mutua del `_id` haga de verdad idempotente al
 *     `insertIfAbsent` -- el segundo intento NO sobrescribe las tiradas ya
 *     guardadas;
 *   - y que un "reinicio" de Combat (instancia nueva del repositorio sobre la
 *     MISMA base) siga viendo el lote, que es lo que impide volver a tirar el
 *     dado y pagar dos veces el mismo hecho.
 */
describe('MongoExperienceRollRepository', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db
  let repository: MongoExperienceRollRepository

  /**
   * Las pruebas del validador escriben documentos INVALIDOS a proposito, asi que
   * la coleccion se lee aqui sin el tipo del producto: `_id` es cadena (el
   * `operationId`) y el resto se comprueba en la Base, no en el compilador.
   */
  const rawCollection = () =>
    db.collection<Record<string, unknown> & { _id: string }>(EXPERIENCE_ROLLS_COLLECTION)

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)

    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }

    repository = new MongoExperienceRollRepository(db)
  }, 120_000)

  afterAll(async () => {
    await client.close()
    await container.stop()
  })

  let counter = 0
  const intent = (
    overrides: Partial<ExperienceRollBatchIntent> = {},
  ): ExperienceRollBatchIntent => {
    counter += 1

    return {
      operationId: overrides.operationId ?? `mission:enr-${String(counter)}:xp-rolls`,
      enrollmentId: overrides.enrollmentId ?? `enr-${String(counter)}`,
      simulationId: overrides.simulationId ?? `sim-${String(counter)}`,
      heroId: overrides.heroId ?? '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
      defeats: overrides.defeats ?? [
        {
          encounterId: '1',
          enemyInstanceId: 'sombra-corrompida#1',
          rivalRef: 'sombra-corrompida',
          roll: 5,
        },
        {
          encounterId: '1',
          enemyInstanceId: 'sombra-corrompida#2',
          rivalRef: 'sombra-corrompida',
          roll: 1,
        },
        {
          encounterId: '5',
          enemyInstanceId: 'guardian-eterno#1',
          rivalRef: 'guardian-eterno',
          roll: 8,
        },
      ],
    }
  }

  it('la migracion 013-experience-rolls esta registrada en el orden que le toca', () => {
    const names = MIGRATIONS.map((migration) => migration.name)
    expect(names.indexOf('013-experience-rolls')).toBeGreaterThan(
      names.indexOf('012-battle-rooms-participant-index'),
    )
  })

  it('guarda el lote ENTERO en UN SOLO documento cuyo _id es el operationId', async () => {
    const operationId = 'mission:enr-unico:xp-rolls'
    const { batch, created } = await repository.insertIfAbsent(intent({ operationId }))

    expect(created).toBe(true)
    expect(batch.operationId).toBe(operationId)

    const documents = await rawCollection().find({ enrollmentId: batch.enrollmentId }).toArray()

    expect(documents).toHaveLength(1)
    expect(documents[0]?._id).toBe(operationId)
    expect(documents[0]?.defeats).toHaveLength(3)
  })

  it('la ida y vuelta conserva tiradas, identificadores de instancia y fechas', async () => {
    const operationId = 'mission:enr-vuelta:xp-rolls'
    await repository.insertIfAbsent(intent({ operationId }))

    const stored = await repository.findById(operationId)

    expect(stored?.defeats.map((defeat) => defeat.roll)).toEqual([5, 1, 8])
    expect(stored?.defeats.map((defeat) => defeat.enemyInstanceId)).toEqual([
      'sombra-corrompida#1',
      'sombra-corrompida#2',
      'guardian-eterno#1',
    ])
    expect(stored?.defeats[0]?.rivalRef).toBe('sombra-corrompida')
    expect(stored?.defeats[0]?.persistedAt).toBeInstanceOf(Date)
    expect(stored?.createdAt).toBeInstanceOf(Date)
  })

  it('un operationId desconocido devuelve null, no un error', async () => {
    expect(await repository.findById('mission:no-existe:xp-rolls')).toBeNull()
  })

  it('el segundo intend con el MISMO operationId NO sobrescribe: devuelve lo guardado y created:false', async () => {
    const operationId = 'mission:enr-idem:xp-rolls'
    const first = await repository.insertIfAbsent(intent({ operationId }))

    const second = await repository.insertIfAbsent(
      intent({
        operationId,
        defeats: [{ encounterId: '9', enemyInstanceId: 'otro#1', rivalRef: 'otro', roll: 7 }],
      }),
    )

    expect(second.created).toBe(false)
    expect(second.batch.defeats.map((defeat) => defeat.roll)).toEqual(
      first.batch.defeats.map((defeat) => defeat.roll),
    )
    expect(second.batch.defeats).toHaveLength(3)
    // Y en la Base tampoco: sigue habiendo un unico documento, el original.
    expect(await rawCollection().countDocuments({ _id: operationId })).toBe(1)
  })

  it('un "reinicio" de Combat (instancia nueva sobre la MISMA base) sigue viendo el lote: no se vuelve a tirar', async () => {
    const operationId = 'mission:enr-reinicio:xp-rolls'
    await repository.insertIfAbsent(intent({ operationId }))

    const afterRestart = new MongoExperienceRollRepository(db)
    const recovered = await afterRestart.findById(operationId)

    expect(recovered?.defeats.map((defeat) => defeat.roll)).toEqual([5, 1, 8])
  })

  it('el lote de UNA derrota es el mismo contrato', async () => {
    const operationId = 'mission:enr-una:xp-rolls'
    const { batch } = await repository.insertIfAbsent(
      intent({
        operationId,
        defeats: [
          {
            encounterId: '5',
            enemyInstanceId: 'guardian-eterno#1',
            rivalRef: 'guardian-eterno',
            roll: 3,
          },
        ],
      }),
    )

    expect(batch.defeats).toHaveLength(1)
    expect((await repository.findById(operationId))?.defeats).toHaveLength(1)
  })

  it('el validador de la Base rechaza una tirada fuera del dado (0 y 9)', async () => {
    for (const roll of [0, 9]) {
      await expect(
        rawCollection().insertOne({
          _id: `mission:enr-invalido-${String(roll)}:xp-rolls`,
          enrollmentId: 'enr-invalido',
          simulationId: 'sim-invalido',
          heroId: 'hero-invalido',
          defeats: [
            {
              encounterId: '1',
              enemyInstanceId: 'a#1',
              rivalRef: 'a',
              roll,
              persistedAt: new Date(),
            },
          ],
          createdAt: new Date(),
        }),
      ).rejects.toThrow()
    }
  })

  it('el validador de la Base rechaza un lote SIN derrotas', async () => {
    await expect(
      rawCollection().insertOne({
        _id: 'mission:enr-vacio:xp-rolls',
        enrollmentId: 'enr-vacio',
        simulationId: 'sim-vacio',
        heroId: 'hero-vacio',
        defeats: [],
        createdAt: new Date(),
      }),
    ).rejects.toThrow()
  })

  it('el validador de la Base rechaza un campo que el contrato no declara', async () => {
    await expect(
      rawCollection().insertOne({
        _id: 'mission:enr-extra:xp-rolls',
        enrollmentId: 'enr-extra',
        simulationId: 'sim-extra',
        heroId: 'hero-extra',
        defeats: [
          {
            encounterId: '1',
            enemyInstanceId: 'a#1',
            rivalRef: 'a',
            roll: 4,
            persistedAt: new Date(),
          },
        ],
        createdAt: new Date(),
        xpAmount: 999,
      }),
    ).rejects.toThrow()
  })

  it('la coleccion no tiene indices secundarios: todo se consulta por _id', async () => {
    const indexes = await rawCollection().indexes()

    expect(indexes.map((index) => index.name)).toEqual(['_id_'])
  })
})
