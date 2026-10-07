import 'reflect-metadata'

import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { type Collection, type Db, type MongoClient } from 'mongodb'

import {
  BattleRoom,
  type CreateBattleRoomInput,
  type CreateTournamentRoomInput,
} from '../../src/domain/entities/BattleRoom'
import { Combatant } from '../../src/domain/entities/Combatant'
import { createCombatProfile } from '../../src/domain/entities/CombatProfile'
import type { TurnOrderEntry } from '../../src/domain/entities/TurnOrder'
import { RoomConflictError } from '../../src/application/errors/ApplicationError'
import { up as addHeroLevelToProfiles } from '../../src/adapters/outbound/persistence/migrations/017-battle-rooms-hero-level'
import { TOURNAMENT_OPERATION_INDEX } from '../../src/adapters/outbound/persistence/migrations/018-battle-rooms-tournament'
import { up as addEpicToProfiles } from '../../src/adapters/outbound/persistence/migrations/020-battle-rooms-epic'
import { golpeDeDefensaEpic } from '../fixtures/equipped-hero'
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

  /**
   * HU-21 (migracion 009): `findInBattle` solo devuelve salas con batalla EN
   * CURSO, y una sala FINISHED sobrevive al viaje con su `result` intacto.
   */
  const startedRoom = (id: string, level?: number): BattleRoom => {
    let room = BattleRoom.create(id, CREATOR, validInput(), AT)

    room = room.join(CREATOR, 'A', AT, 'Creador', 'hero-a', 0)
    room = room.join('jugador-b', 'B', AT, 'Rival', 'hero-b', 0)

    const order: TurnOrderEntry[] = [
      {
        teamLabel: 'A',
        seat: 0,
        kind: 'HUMAN',
        playerId: CREATOR,
        displayName: 'Creador',
        heroId: 'hero-a',
        heroSubtype: 'GUERRERO_ARMAS',
      },
      {
        teamLabel: 'B',
        seat: 0,
        kind: 'HUMAN',
        playerId: 'jugador-b',
        displayName: 'Rival',
        heroId: 'hero-b',
        heroSubtype: 'GUERRERO_ARMAS',
      },
    ]
    const combatants = order.map((entry) =>
      Combatant.start(
        entry,
        createCombatProfile({
          heroId: entry.heroId ?? 'hero',
          subtype: 'GUERRERO_ARMAS',
          maxHealth: 44,
          attack: 10,
          defense: 11,
          damage: { mode: 'DICE', count: 1, sides: 6 },
          activeEffects: [],
          ...(level === undefined ? {} : { level }),
        }),
      ),
    )

    return room.startBattle(order, AT, combatants)
  }

  /**
   * HU-08 (CA-06, migracion 017): el perfil congelado lleva `level`. El validador tenia
   * `additionalProperties: false` en el perfil, asi que sin la migracion la batalla no
   * podria persistirse. Se comprueba contra el motor real, y que reaplicarla es inocua.
   */
  it('el perfil de combate con `level` se persiste y se recupera (migracion 017)', async () => {
    await repository.save(startedRoom('3f1c2a4e-7b1d-4c3e-9a10-0d7e5b6c8a01', 3), 0)

    const found = await repository.findById('3f1c2a4e-7b1d-4c3e-9a10-0d7e5b6c8a01')
    const profile = found?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.profile

    expect(profile?.level).toBe(3)
  })

  it('un perfil sin `level` (anterior a CA-06) sigue siendo valido', async () => {
    await repository.save(startedRoom('3f1c2a4e-7b1d-4c3e-9a10-0d7e5b6c8a02'), 0)

    const profile = (
      await repository.findById('3f1c2a4e-7b1d-4c3e-9a10-0d7e5b6c8a02')
    )?.battle?.combatantFor({
      teamLabel: 'A',
      seat: 0,
    })?.profile

    expect(profile).not.toHaveProperty('level')
  })

  it('la migracion 017 es idempotente y el motor rechaza un `level` fuera de 1..8', async () => {
    await addHeroLevelToProfiles(db)
    await addHeroLevelToProfiles(db)

    await repository.save(startedRoom('3f1c2a4e-7b1d-4c3e-9a10-0d7e5b6c8a03', 8), 0)
    expect(
      (await repository.findById('3f1c2a4e-7b1d-4c3e-9a10-0d7e5b6c8a03'))?.battle,
    ).not.toBeNull()

    const stored = await rooms().findOne({ _id: '3f1c2a4e-7b1d-4c3e-9a10-0d7e5b6c8a03' })
    const fixed = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>
    const battle = fixed.battle as { combatants: { profile: { level: number } }[] }
    battle.combatants[0]!.profile.level = 9
    fixed._id = '3f1c2a4e-7b1d-4c3e-9a10-0d7e5b6c8a04'

    await expect(rooms().insertOne(fixed as never)).rejects.toThrow()
  })

  /**
   * HU-31 (contrato `hu-31-equipped-epic-v1`, migracion 020): el perfil congelado lleva
   * `epic`. El validador tenia `additionalProperties: false` en el perfil, asi que sin la
   * migracion la batalla no podria persistirse con una epica equipada. Se comprueba contra el
   * motor real, y que reaplicarla es inocua.
   */
  const startedRoomWithEpic = (id: string): BattleRoom => {
    let room = BattleRoom.create(id, CREATOR, validInput(), AT)

    room = room.join(CREATOR, 'A', AT, 'Creador', 'hero-a', 0)
    room = room.join('jugador-b', 'B', AT, 'Rival', 'hero-b', 0)

    const order: TurnOrderEntry[] = [
      {
        teamLabel: 'A',
        seat: 0,
        kind: 'HUMAN',
        playerId: CREATOR,
        displayName: 'Creador',
        heroId: 'hero-a',
        heroSubtype: 'GUERRERO_ARMAS',
      },
      {
        teamLabel: 'B',
        seat: 0,
        kind: 'HUMAN',
        playerId: 'jugador-b',
        displayName: 'Rival',
        heroId: 'hero-b',
        heroSubtype: 'GUERRERO_ARMAS',
      },
    ]
    const combatants = order.map((entry) =>
      Combatant.start(
        entry,
        createCombatProfile({
          heroId: entry.heroId ?? 'hero',
          subtype: 'GUERRERO_ARMAS',
          maxHealth: 44,
          attack: 10,
          defense: 11,
          damage: { mode: 'DICE', count: 1, sides: 6 },
          activeEffects: [],
          epic: golpeDeDefensaEpic,
        }),
      ),
    )

    return room.startBattle(order, AT, combatants)
  }

  it('el perfil de combate con `epic` se persiste y se recupera (migracion 020)', async () => {
    const id = nextId()
    await repository.save(startedRoomWithEpic(id), 0)

    const profile = (await repository.findById(id))?.battle?.combatantFor({
      teamLabel: 'A',
      seat: 0,
    })?.profile

    expect(profile?.epic?.epicReference).toBe(golpeDeDefensaEpic.epicReference)
    expect(profile?.epic?.applied.additionalApplied).not.toBeNull()
  })

  it('un perfil sin `epic` (heroe sin epica equipada) sigue siendo valido', async () => {
    const id = nextId()
    await repository.save(startedRoom(id), 0)

    const profile = (await repository.findById(id))?.battle?.combatantFor({
      teamLabel: 'A',
      seat: 0,
    })?.profile

    expect(profile).not.toHaveProperty('epic')
  })

  it('la migracion 020 es idempotente y el motor rechaza una `epic` incompleta', async () => {
    await addEpicToProfiles(db)
    await addEpicToProfiles(db)

    const id = nextId()
    await repository.save(startedRoomWithEpic(id), 0)
    expect((await repository.findById(id))?.battle).not.toBeNull()

    const stored = await rooms().findOne({ _id: id })
    const fixed = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>
    const battle = fixed.battle as {
      combatants: { profile: { epic?: Record<string, unknown> } }[]
    }
    delete battle.combatants[0]!.profile.epic!.applied
    fixed._id = nextId()

    await expect(rooms().insertOne(fixed as never)).rejects.toThrow()
  })

  it('findInBattle devuelve solo salas IN_BATTLE', async () => {
    const inBattleId = nextId()
    const waitingId = nextId()
    const finishedId = nextId()

    await repository.save(startedRoom(inBattleId), 0)
    await repository.save(BattleRoom.create(waitingId, CREATOR, validInput(), AT), 0)

    const finished = await repository.save(startedRoom(finishedId), 0)
    await repository.save(finished.finish({ reason: 'TIME_LIMIT' }, AT), finished.version)

    const found = await repository.findInBattle()
    const ids = found.map((room) => room.id)

    expect(ids).toContain(inBattleId)
    expect(ids).not.toContain(waitingId)
    expect(ids).not.toContain(finishedId)
    expect(found.every((room) => room.status === 'IN_BATTLE')).toBe(true)
  })

  describe('findActiveByParticipant (migracion 012, volver a mi sala)', () => {
    const PLAYER = 'jugador-mis-salas'

    it('la migracion 012 crea los indices de participante y de creador', async () => {
      const indexes = await rooms().indexes()
      const byName = (name: string) => indexes.find((candidate) => candidate.name === name)?.key

      expect(byName('teams.participants.playerId_1_status_1')).toEqual({
        'teams.participants.playerId': 1,
        status: 1,
      })
      expect(byName('createdBy_1_status_1')).toEqual({ createdBy: 1, status: 1 })
    })

    it('la consulta usa ese indice (plan del motor)', async () => {
      const plan = (await rooms()
        .find({
          'teams.participants.playerId': PLAYER,
          status: { $in: ['WAITING_FOR_PLAYERS', 'PREPARING', 'IN_BATTLE'] },
        })
        .explain()) as { queryPlanner: { winningPlan: unknown } }

      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
        'teams.participants.playerId_1_status_1',
      )
    })

    it('devuelve solo las salas NO terminales del jugador, de la mas reciente a la mas antigua', async () => {
      const older = nextId()
      const newer = nextId()
      const foreign = nextId()
      const inBattle = nextId()
      const finishedId = nextId()

      const waiting = (id: string, at: Date, player: string) =>
        BattleRoom.create(
          id,
          CREATOR,
          validInput({ teamConfigs: [{ capacity: 2 }, { capacity: 2 }] }),
          at,
        ).join(player, 'A', at, `Nombre ${player}`, `hero-${player}`, 0)

      await repository.save(waiting(older, new Date('2026-09-17T08:00:00.000Z'), PLAYER), 0)
      await repository.save(waiting(newer, new Date('2026-09-17T09:00:00.000Z'), PLAYER), 0)
      await repository.save(waiting(foreign, AT, 'otro-jugador'), 0)
      await repository.save(startedRoom(inBattle), 0)
      const finished = await repository.save(startedRoom(finishedId), 0)
      await repository.save(finished.finish({ reason: 'TIME_LIMIT' }, AT), finished.version)

      const mine = await repository.findActiveByParticipant(PLAYER)
      const creators = await repository.findActiveByParticipant(CREATOR)

      expect(mine.map((room) => room.id)).toEqual([newer, older])

      const createdOnly = nextId()
      await repository.save(BattleRoom.create(createdOnly, 'creadora-sola', validInput(), AT), 0)
      expect(
        (await repository.findActiveByParticipant('creadora-sola')).map((room) => room.id),
      ).toEqual([createdOnly])
      expect(creators.map((room) => room.id)).toContain(inBattle)
      expect(creators.map((room) => room.id)).not.toContain(finishedId)
      expect(await repository.findActiveByParticipant('nadie')).toEqual([])
    })
  })

  it('una sala FINISHED viaja con su resultado y su turno, y no se reescribe', async () => {
    const id = nextId()
    const saved = await repository.save(startedRoom(id), 0)
    const finished = saved.finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, AT)
    const persisted = await repository.save(finished, saved.version)

    expect(persisted.version).toBe(saved.version + 1)

    const reloaded = await repository.findById(id)

    expect(reloaded?.status).toBe('FINISHED')
    expect(reloaded?.result).toEqual(finished.result)
    expect(reloaded?.result?.reason).toBe('ELIMINATION')
    expect(reloaded?.battle?.turnStartedAt).toEqual(AT)
    expect(reloaded?.events.at(-1)?.type).toBe('battleFinished')
    expect(reloaded?.battle?.combatants?.[0]?.currentHealth).toBe(44)
  })

  it('el motor rechaza un `result` con causa desconocida (migracion 009)', async () => {
    const id = nextId()
    const saved = await repository.save(startedRoom(id), 0)
    const finished = saved.finish({ reason: 'TIME_LIMIT' }, AT)

    await repository.save(finished, saved.version)

    const document = await rooms().findOne({ _id: id })
    const result = document?.result as Record<string, unknown>

    await expect(
      rooms().insertOne({ ...document, _id: nextId(), result: { ...result, reason: 'SURRENDER' } }),
    ).rejects.toThrow()
  })

  it('el motor rechaza un evento de tipo desconocido (migracion 009)', async () => {
    const id = nextId()
    const saved = await repository.save(startedRoom(id), 0)

    await repository.save(saved.finish({ reason: 'TIME_LIMIT' }, AT), saved.version)

    const document = await rooms().findOne({ _id: id })
    const events = (document?.events ?? []) as { type: string }[]

    await expect(
      rooms().insertOne({
        ...document,
        _id: nextId(),
        events: [{ ...events[0], type: 'battleExploded' }, ...events.slice(1)],
      }),
    ).rejects.toThrow()
  })

  it('el motor acepta una apuesta tras la migracion 011, y el repositorio la persiste y recupera', async () => {
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

    const withStake = found
      .join('jugador-b', 'B', AT, 'Nombre Visible', 'heroe-b', 4, {
        amount: 25,
        holdOperationId: `battle:${id}:player:jugador-b:stake:reserve`,
      })
      .withStakesActivated()
    await repository.save(withStake, found.version)

    const reloaded = await repository.findById(id)

    expect(reloaded?.stakeOf('jugador-b')).toEqual({
      amount: 25,
      holdOperationId: `battle:${id}:player:jugador-b:stake:reserve`,
      status: 'ACTIVE',
    })
  })

  it('el motor rechaza una apuesta con estado desconocido (migracion 011)', async () => {
    const id = nextId()
    const room = BattleRoom.create(id, CREATOR, validInput(), AT)
    await repository.save(room, 0)

    const document = await rooms().findOne({ _id: id })
    const teams = (document?.teams ?? []) as {
      label: string
      capacity: number
      participants: Record<string, unknown>[]
    }[]

    await expect(
      rooms().insertOne({
        ...document,
        _id: nextId(),
        teams: [
          {
            ...teams[0],
            participants: [
              {
                kind: 'HUMAN',
                playerId: 'jugador-1',
                heroId: null,
                displayName: null,
                joinedAt: AT,
                stake: {
                  amount: 10,
                  holdOperationId: 'hold-1',
                  status: 'PENDING_RELEASE',
                },
              },
            ],
          },
          teams[1],
        ],
      }),
    ).rejects.toThrow()
  })

  /**
   * Management#517 (EN de `tournament-rooms`, migracion 018): el campo
   * `tournament` y el indice unico que sostiene la idempotencia de
   * `CreateTournamentRoom` contra el motor REAL.
   */
  describe('tournament (Management#517)', () => {
    const tournamentInput = (
      overrides: Partial<CreateTournamentRoomInput> = {},
    ): CreateTournamentRoomInput => ({
      operationId: `op-${nextId()}`,
      tournamentId: 'T1',
      encounterId: 'T1:E1',
      requestHash: 'a'.repeat(64),
      teams: [
        {
          teamId: 'equipo1',
          members: [
            { playerId: 'p1', heroId: 'hero-p1', heroLoadoutVersion: 0, displayName: 'P1' },
            { playerId: 'p2', heroId: 'hero-p2', heroLoadoutVersion: 0, displayName: 'P2' },
          ],
        },
        {
          teamId: 'equipo2',
          members: [
            { playerId: 'p3', heroId: 'hero-p3', heroLoadoutVersion: 0, displayName: 'P3' },
            { playerId: 'p4', heroId: 'hero-p4', heroLoadoutVersion: 0, displayName: 'P4' },
          ],
        },
      ],
      ...overrides,
    })

    it('la migracion 018 crea el indice unico sobre tournament.operationId', async () => {
      const indexes = await rooms().indexes()
      const names = indexes.map((index) => index.name)

      expect(names).toContain(TOURNAMENT_OPERATION_INDEX)
    })

    it('guarda y recupera una sala de torneo con `tournament` intacto', async () => {
      const id = nextId()
      const input = tournamentInput()
      const room = BattleRoom.createTournamentRoom(id, 'tournament:T1', input, AT)

      await repository.save(room, 0)
      const reloaded = await repository.findById(id)

      expect(reloaded?.status).toBe('PREPARING')
      expect(reloaded?.tournament).toEqual({
        operationId: input.operationId,
        tournamentId: 'T1',
        encounterId: 'T1:E1',
        requestHash: 'a'.repeat(64),
      })
    })

    it('findByTournamentOperationId encuentra la sala por operationId', async () => {
      const id = nextId()
      const input = tournamentInput()
      const room = BattleRoom.createTournamentRoom(id, 'tournament:T1', input, AT)
      await repository.save(room, 0)

      const found = await repository.findByTournamentOperationId(input.operationId)
      expect(found?.id).toBe(id)

      await expect(
        repository.findByTournamentOperationId('operationId-inexistente'),
      ).resolves.toBeNull()
    })

    it('una sala sin tournament nunca aparece en findByTournamentOperationId ni "ocupa" el indice', async () => {
      const lobbyId = nextId()
      await repository.save(BattleRoom.create(lobbyId, CREATOR, validInput(), AT), 0)

      const first = tournamentInput()
      const second = tournamentInput()
      await repository.save(
        BattleRoom.createTournamentRoom(nextId(), 'tournament:T1', first, AT),
        0,
      )
      await repository.save(
        BattleRoom.createTournamentRoom(nextId(), 'tournament:T1', second, AT),
        0,
      )

      await expect(
        repository.findByTournamentOperationId(first.operationId),
      ).resolves.not.toBeNull()
      await expect(
        repository.findByTournamentOperationId(second.operationId),
      ).resolves.not.toBeNull()
    })

    it('findActiveByParticipant NUNCA devuelve una sala de torneo (aislamiento del lobby publico)', async () => {
      const id = nextId()
      const input = tournamentInput()
      const room = BattleRoom.createTournamentRoom(id, 'tournament:T1', input, AT)
      await repository.save(room, 0)

      // La sala de torneo nace en PREPARING con sus 4 jugadores humanos ya
      // resueltos: sin el filtro `tournament: null`, cada uno de ellos la
      // veria mezclada con sus salas normales en la ruta PUBLICA
      // `GET /v1/combat/me/rooms`.
      for (const playerId of ['p1', 'p2', 'p3', 'p4']) {
        const mine = await repository.findActiveByParticipant(playerId)
        expect(mine.map((found) => found.id)).not.toContain(id)
      }
    })

    it('el indice unico rechaza DOS salas distintas con el MISMO operationId (RoomConflictError)', async () => {
      const operationId = `op-duplicado-${nextId()}`
      const first = BattleRoom.createTournamentRoom(
        nextId(),
        'tournament:T1',
        tournamentInput({ operationId }),
        AT,
      )
      const second = BattleRoom.createTournamentRoom(
        nextId(),
        'tournament:T1',
        tournamentInput({ operationId }),
        AT,
      )

      await repository.save(first, 0)

      await expect(repository.save(second, 0)).rejects.toBeInstanceOf(RoomConflictError)
    })

    it('el motor rechaza un `tournament` sin requestHash (fuera del esquema $jsonSchema)', async () => {
      const id = nextId()
      const room = BattleRoom.createTournamentRoom(id, 'tournament:T1', tournamentInput(), AT)
      await repository.save(room, 0)

      const document = await rooms().findOne({ _id: id })

      await expect(
        rooms().insertOne({
          ...document,
          _id: nextId(),
          tournament: {
            operationId: `op-${nextId()}`,
            tournamentId: 'T1',
            encounterId: 'T1:E1',
            // requestHash ausente: el validador lo exige en `required`.
          },
        }),
      ).rejects.toThrow()
    })
  })
})
