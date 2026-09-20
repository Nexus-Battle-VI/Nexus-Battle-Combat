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

  /**
   * HU-15.2 (RF-15): control de concurrencia real sobre `join()` contra
   * Mongo. Dos jugadores DISTINTOS compiten por el UNICO cupo restante de la
   * sala -- exactamente uno debe prosperar (200/version+1, status
   * PREPARING), el otro debe recibir `RoomConflictError`. El documento final
   * en Mongo nunca debe tener `totalParticipants > totalCapacity`.
   */
  it('join(): dos jugadores compitiendo por el ultimo cupo -- uno gana, el otro choca (RoomConflictError)', async () => {
    const id = nextId()
    const room = BattleRoom.create(
      id,
      CREATOR,
      validInput({
        teamConfigs: [
          { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
          { capacity: 1 },
        ],
      }),
      AT,
    )
    const guardada = await repository.save(room, 0)

    const resultados = await Promise.allSettled([
      repository.save(guardada.join('jugador-a', null, AT), guardada.version),
      repository.save(guardada.join('jugador-b', null, AT), guardada.version),
    ])

    const cumplidas = resultados.filter((entry) => entry.status === 'fulfilled')
    const rechazadas = resultados.filter((entry) => entry.status === 'rejected')

    expect(cumplidas).toHaveLength(1)
    expect(rechazadas).toHaveLength(1)
    expect(rechazadas[0]?.status === 'rejected' && rechazadas[0].reason).toBeInstanceOf(
      RoomConflictError,
    )

    const documento = await rooms().findOne({ _id: id })
    const teams = documento?.teams as { capacity: number; participants: unknown[] }[]
    const totalCapacity = teams.reduce((sum, team) => sum + team.capacity, 0)
    const totalParticipants = teams.reduce((sum, team) => sum + team.participants.length, 0)

    expect(totalParticipants).toBeLessThanOrEqual(totalCapacity)
    expect(totalParticipants).toBe(totalCapacity)
    expect(documento?.status).toBe('PREPARING')
  })

  /**
   * Control de un conflicto de bloqueo optimista NO relacionado con el
   * ultimo cupo: dos joins concurrentes a equipos DISTINTOS, con cupo de
   * sobra en ambos. Confirma que el patron de version+replaceOne detecta
   * cualquier escritura concurrente sobre el mismo documento, no solo la del
   * ultimo cupo.
   */
  it('join(): dos joins concurrentes a equipos distintos con cupo de sobra tambien producen un conflicto de version', async () => {
    const id = nextId()
    const room = BattleRoom.create(
      id,
      CREATOR,
      validInput({ teamConfigs: [{ capacity: 2 }, { capacity: 2 }] }),
      AT,
    )
    const guardada = await repository.save(room, 0)

    const resultados = await Promise.allSettled([
      repository.save(guardada.join('jugador-a', 'A', AT), guardada.version),
      repository.save(guardada.join('jugador-b', 'B', AT), guardada.version),
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

  it('el motor acepta status PREPARING tras la migracion 002 (HU-15.2)', async () => {
    await expect(
      rooms().insertOne({
        _id: nextId(),
        mode: 'PVP',
        status: 'PREPARING',
        teams: [
          { label: 'A', capacity: 1, participants: [] },
          { label: 'B', capacity: 1, participants: [] },
        ],
        reward: { amount: 0 },
        createdBy: CREATOR,
        createdAt: AT,
        version: 0,
      }),
    ).resolves.toBeDefined()
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

  /**
   * HU-16.2 (DP-6 de la auditoria HU-16.1, migracion 004): el motor real
   * acepta `heroLoadoutVersion` en un participante, y `join()` lo persiste y
   * lo recupera de verdad, no solo contra el mapeo puro (ya cubierto por
   * `battle-room-mapping.spec.ts`).
   */
  it('el motor acepta heroLoadoutVersion tras la migracion 004 (HU-16.2), y join() lo persiste y recupera', async () => {
    const id = nextId()
    const room = BattleRoom.create(
      id,
      CREATOR,
      validInput({ teamConfigs: [{ capacity: 2 }, { capacity: 2 }] }),
      AT,
    )
    await repository.save(room, 0)

    const found = await repository.findById(id)
    if (found === null) throw new Error('la sala debia existir')

    const joined = found.join('jugador-b', null, AT, 'Nombre Visible', 'heroe-b', 4)
    await repository.save(joined, found.version)

    const reloaded = await repository.findById(id)
    const allParticipants = [
      ...(reloaded?.teams[0].participants ?? []),
      ...(reloaded?.teams[1].participants ?? []),
    ]

    expect(allParticipants).toContainEqual(
      expect.objectContaining({ playerId: 'jugador-b', heroLoadoutVersion: 4 }),
    )
  })

  it('el motor rechaza heroLoadoutVersion negativo (fuera del esquema $jsonSchema)', async () => {
    await expect(
      rooms().insertOne({
        _id: nextId(),
        mode: 'PVP',
        status: 'WAITING_FOR_PLAYERS',
        teams: [
          {
            label: 'A',
            capacity: 1,
            participants: [
              {
                kind: 'HUMAN',
                playerId: 'jugador-1',
                heroId: 'heroe-1',
                heroLoadoutVersion: -1,
                joinedAt: AT,
              },
            ],
          },
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
