import 'reflect-metadata'

import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { type Collection, type Db, type MongoClient } from 'mongodb'

import { BattleRoom, type CreateBattleRoomInput } from '../../src/domain/entities/BattleRoom'
import { RoomConflictError } from '../../src/application/errors/ApplicationError'
import { MongoBattleRoomRepository } from '../../src/adapters/outbound/persistence/MongoBattleRoomRepository'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'

/**
 * Sala de batalla contra un MongoDB REAL, en contenedor (HU-14).
 *
 * Comprueba lo que un doble no puede: que la migracion `001-battle-rooms`
 * exista de verdad, que el validador `$jsonSchema` rechace documentos
 * malformados, y que el bloqueo optimista de `save` sea real.
 */
describe('MongoBattleRoomRepository', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db
  let repository: MongoBattleRoomRepository

  const AT = new Date('2026-09-17T10:00:00.000Z')
  const CREATOR = 'jugador-hu14'

  let counter = 0
  const nextId = (): string => {
    counter += 1
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
  }

  const validInput = (overrides: Partial<CreateBattleRoomInput> = {}): CreateBattleRoomInput => ({
    mode: 'PVP',
    teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
    reward: { amount: 0 },
    ...overrides,
  })

  const rooms = (): Collection<Record<string, unknown> & { _id: string }> =>
    db.collection<Record<string, unknown> & { _id: string }>('battle-rooms')

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)

    const { error } = await migrateToLatest(db)
    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }

    repository = new MongoBattleRoomRepository(db)
  }, 180_000)

  afterAll(async () => {
    await client.close()
    await container.stop()
  })

  it('la migracion crea la coleccion con los indices esperados', async () => {
    const indexes = await rooms().indexes()
    const names = indexes.map((index) => index.name)

    expect(names).toContain('status_1')
    expect(names).toContain('status_1_createdAt_-1')
  })

  it('sin sala previa devuelve null', async () => {
    await expect(repository.findById(nextId())).resolves.toBeNull()
  })

  it('guarda una sala y la recupera con el mismo id', async () => {
    const id = nextId()
    const room = BattleRoom.create(id, CREATOR, validInput(), AT)

    const guardada = await repository.save(room, 0)

    expect(guardada.version).toBe(1)

    const documento = await rooms().findOne({ _id: id })
    expect(documento).toMatchObject({ _id: id, mode: 'PVP', status: 'WAITING_FOR_PLAYERS' })

    await expect(repository.findById(id)).resolves.toMatchObject({ id, version: 1 })
  })

  it('findWaitingForPlayers devuelve solo salas en WAITING_FOR_PLAYERS', async () => {
    const waitingId = nextId()
    const cancelledId = nextId()

    const waiting = BattleRoom.create(waitingId, CREATOR, validInput(), AT)
    const toCancel = BattleRoom.create(cancelledId, CREATOR, validInput(), AT)

    await repository.save(waiting, 0)
    const savedToCancel = await repository.save(toCancel, 0)
    await repository.save(savedToCancel.cancel(CREATOR), savedToCancel.version)

    const disponibles = await repository.findWaitingForPlayers()
    const ids = disponibles.map((room) => room.id)

    expect(ids).toContain(waitingId)
    expect(ids).not.toContain(cancelledId)
  })

  /**
   * CONTROL del bloqueo optimista con el motor real: dos cancelaciones
   * concurrentes de la misma sala, una gana y la otra choca.
   */
  it('dos escrituras concurrentes con la misma version esperada: una gana, la otra choca', async () => {
    const id = nextId()
    const room = BattleRoom.create(id, CREATOR, validInput(), AT)
    const guardada = await repository.save(room, 0)

    const resultados = await Promise.allSettled([
      repository.save(guardada.cancel(CREATOR), guardada.version),
      repository.save(guardada.cancel(CREATOR), guardada.version),
    ])

    const cumplidas = resultados.filter((entry) => entry.status === 'fulfilled')
    const rechazadas = resultados.filter((entry) => entry.status === 'rejected')

    expect(cumplidas).toHaveLength(1)
    expect(rechazadas).toHaveLength(1)
    expect(rechazadas[0]?.status === 'rejected' && rechazadas[0].reason).toBeInstanceOf(
      RoomConflictError,
    )
  })

  it('la migracion es idempotente: reaplicarla no repite la ejecucion', async () => {
    const outcome = await migrateToLatest(db)

    expect(outcome.applied).toEqual([])
    expect(outcome.error).toBeUndefined()
  })

  /**
   * El validador vive en el motor y no en la aplicacion. Se comprueba
   * escribiendo a mano un documento con un campo de mas: si el validador no
   * existiera, la insercion pasaria y esta prueba fallaria.
   */
  it('el motor rechaza un documento con campos ajenos al esquema', async () => {
    await expect(
      rooms().insertOne({
        _id: nextId(),
        mode: 'PVP',
        status: 'WAITING_FOR_PLAYERS',
        teams: [
          { label: 'A', capacity: 1, participants: [] },
          { label: 'B', capacity: 1, participants: [] },
        ],
        reward: { amount: 0 },
        createdBy: CREATOR,
        createdAt: AT,
        version: 0,
        campoInventado: true,
      }),
    ).rejects.toThrow()
  })

  it('el motor rechaza un mode fuera del enum', async () => {
    await expect(
      rooms().insertOne({
        _id: nextId(),
        mode: 'DESCONOCIDA',
        status: 'WAITING_FOR_PLAYERS',
        teams: [
          { label: 'A', capacity: 1, participants: [] },
          { label: 'B', capacity: 1, participants: [] },
        ],
        reward: { amount: 0 },
        createdBy: CREATOR,
        createdAt: AT,
        version: 0,
      }),
    ).rejects.toThrow()
  })
})
