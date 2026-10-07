import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { MongoClient, type Db } from 'mongodb'

import { MongoBattleRoomRepository } from '../../src/adapters/outbound/persistence/MongoBattleRoomRepository'
import { TOURNAMENT_OPERATION_INDEX } from '../../src/adapters/outbound/persistence/migrations/018-battle-rooms-tournament'
import { up as extendTournamentSchema } from '../../src/adapters/outbound/persistence/migrations/026-battle-rooms-tournament-cardinality'
import { GetTournamentRoomRecord } from '../../src/application/use-cases/GetTournamentRoomRecord'
import type { CreateTournamentRoomRequest } from '../../src/application/use-cases/CreateTournamentRoom'
import { TournamentRoomOperationReusedError } from '../../src/application/errors/TournamentRoomErrors'
import { MIGRATIONS, migrateToLatest } from '../../src/infrastructure/persistence/database'
import {
  TOURNAMENT_AT,
  legacyTournamentRequest,
  tournamentHarness,
  tournamentRequest,
} from '../fixtures/tournament-cardinality'

/** Motor Mongo real: el URI opcional permite ejecutarlo tambien sin Docker en Windows. */
describe('MongoDB: salas de torneo v3 y upgrade DUO historico', () => {
  let container: StartedMongoDBContainer | undefined
  let uri: string
  let client: MongoClient
  let db: Db
  const databaseName = `combat_tournament_cardinality_${randomUUID().replaceAll('-', '')}`

  /** Proceso Node nuevo, sin referencias al harness ni posibilidad de inventar otra sala. */
  const replayInFreshProcess = async (request: CreateTournamentRoomRequest) => {
    const script = `
      const fs = require('node:fs');
      const ts = require('typescript');
      require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(
        fs.readFileSync(file, 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }
      ).outputText, file);
      const { MongoClient } = require('mongodb');
      const { MongoBattleRoomRepository } = require('./src/adapters/outbound/persistence/MongoBattleRoomRepository.ts');
      const { CreateTournamentRoom } = require('./src/application/use-cases/CreateTournamentRoom.ts');
      const { StartTournamentRoom } = require('./src/application/use-cases/StartTournamentRoom.ts');
      const { GetTournamentRoomRecord } = require('./src/application/use-cases/GetTournamentRoomRecord.ts');
      const { tournamentRoomCreateRequestOf, tournamentRoomIntentOf } = require('./src/adapters/inbound/http/tournament-room-request.ts');
      const forbidden = () => { throw new Error('Replay intento generar id, consultar upstream o iniciar otra batalla'); };
      (async () => {
        const client = new MongoClient(process.env.COMBAT_REPLAY_MONGO_URI);
        try {
          await client.connect();
          const rooms = new MongoBattleRoomRepository(client.db(process.env.COMBAT_REPLAY_DATABASE));
          const body = JSON.parse(process.argv[1]);
          const request = tournamentRoomCreateRequestOf(body);
          const intent = tournamentRoomIntentOf(body, request);
          const create = new CreateTournamentRoom(rooms, { generate: forbidden }, { now: forbidden }, { getBattleProfile: forbidden }, { getEquippedHero: forbidden });
          const replay = await create.execute(request, intent.hash, intent.version);
          const start = await new StartTournamentRoom(rooms, { startRoom: forbidden }).execute(replay.id, { ...request, operationId: request.operationId + ':start' });
          const record = await new GetTournamentRoomRecord(rooms).execute(replay.id, 0);
          process.stdout.write(JSON.stringify({ replay, start, record }));
        } finally { await client.close(); }
      })().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });
    `
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['-e', script, JSON.stringify(request)],
      {
        cwd: process.cwd(),
        env: { ...process.env, COMBAT_REPLAY_MONGO_URI: uri, COMBAT_REPLAY_DATABASE: databaseName },
        maxBuffer: 2_000_000,
      },
    )
    return JSON.parse(stdout) as {
      replay: { id: string; status: string }
      start: { id: string; status: string }
      record: { teams: { participants: unknown[] }[]; result: { participants: unknown[] } | null }
    }
  }

  const reconnect = async () => {
    await client.close()
    client = new MongoClient(uri)
    await client.connect()
    db = client.db(databaseName)
    return tournamentHarness(new MongoBattleRoomRepository(db))
  }

  beforeAll(async () => {
    if (process.env.COMBAT_TEST_MONGO_URI === undefined) {
      container = await new MongoDBContainer('mongo:8.0').start()
      uri = `${container.getConnectionString()}/?directConnection=true`
    } else {
      uri = process.env.COMBAT_TEST_MONGO_URI
    }
    client = new MongoClient(uri)
    await client.connect()
    db = client.db(databaseName)
    const baseline = await migrateToLatest(
      db,
      MIGRATIONS.filter((migration) => !migration.name.startsWith('026-')),
    )
    if (baseline.error !== undefined)
      throw new Error('fallo la migracion base', { cause: baseline.error })
  }, 180_000)

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
    await container?.stop()
  })

  it('upgrade de 025 a 026 conserva DUO, hash antiguo, aislamiento e indice unico', async () => {
    const h = tournamentHarness(new MongoBattleRoomRepository(db))
    const legacy = legacyTournamentRequest('DUO', 'legacy')
    const created = await h.create(legacy)
    const before = await db.collection('battle-rooms').findOne({ _id: created.id as never })
    const upgraded = await migrateToLatest(db)
    expect(upgraded.error).toBeUndefined()
    expect(upgraded.applied).toEqual(['026-battle-rooms-tournament-cardinality'])
    await extendTournamentSchema(db)
    const after = await db.collection('battle-rooms').findOne({ _id: created.id as never })
    expect(after).toEqual(before)
    const restored = await reconnect()
    expect((await restored.create(legacy)).id).toBe(created.id)
    expect((await restored.start(created.id, legacy)).battle?.turnOrder).toHaveLength(4)
    const room = await restored.rooms.findById(created.id)
    expect(room?.tournament?.mode).toBeUndefined()
    expect(() => room?.leave('legacy-a1')).toThrow()
    expect(await restored.rooms.findWaitingForPlayers()).toHaveLength(0)
    const indexes = await db.collection('battle-rooms').indexes()
    expect(indexes.filter((index) => index.name === TOURNAMENT_OPERATION_INDEX)).toHaveLength(1)
    expect(indexes.find((index) => index.name === TOURNAMENT_OPERATION_INDEX)?.unique).toBe(true)
  })

  it.each(['SOLO', 'DUO', 'TRIO'] as const)(
    '%s persiste y reconstruye todos sus participantes',
    async (mode) => {
      const h = tournamentHarness(new MongoBattleRoomRepository(db))
      const request = tournamentRequest(mode, `db-${mode}`)
      const created = await h.create(request)
      const fresh = await reconnect()
      const replay = await fresh.create(request)
      expect(replay).toEqual(created)
      const started = await fresh.start(created.id, request)
      expect(started.battle?.combatants).toHaveLength(2 * (request.teamSize ?? 0))
      expect((await fresh.rooms.findById(created.id))?.tournament).toMatchObject({
        mode,
        teamSize: request.teamSize,
        contractVersion: 3,
        requestHashVersion: 2,
      })
    },
  )

  it('dos justas y reintentos concurrentes: una sala por operacion, respuesta perdida y reinicio en IN_BATTLE/FINISHED', async () => {
    const h1 = tournamentHarness(new MongoBattleRoomRepository(db))
    const h2 = tournamentHarness(new MongoBattleRoomRepository(db))
    const e1 = tournamentRequest('TRIO', 'concurrent-E1')
    const e2 = tournamentRequest('TRIO', 'concurrent-E2')
    const created = await Promise.all([h1.create(e1), h2.create(e1), h1.create(e2), h2.create(e2)])
    expect(new Set(created.map((room) => room.id)).size).toBe(2)
    for (const request of [e1, e2]) {
      expect(
        await db
          .collection('battle-rooms')
          .countDocuments({ 'tournament.operationId': request.operationId }),
      ).toBe(1)
    }
    const room1 = created[0]
    const room2 = created[2]
    await Promise.all([
      h1.start(room1.id, e1),
      h2.start(room1.id, e1),
      h1.start(room2.id, e2),
      h2.start(room2.id, e2),
    ])
    expect(h1.publisher.published.length + h2.publisher.published.length).toBe(2)
    const fresh = await reconnect()
    for (const request of [e1, e2]) {
      const replay = await fresh.create(request)
      expect(replay.status).toBe('IN_BATTLE')
      const isolated = await replayInFreshProcess(request)
      expect(isolated.replay).toMatchObject({ id: replay.id, status: 'IN_BATTLE' })
      expect(isolated.start).toMatchObject({ id: replay.id, status: 'IN_BATTLE' })
      expect(isolated.record.teams.flatMap((team) => team.participants)).toHaveLength(6)
      expect((await fresh.start(replay.id, request)).id).toBe(replay.id)
      expect(replay.battle?.turnOrder).toHaveLength(6)
      for (let offset = 30_000; offset <= 360_000; offset += 30_000) {
        const room = await fresh.rooms.findById(replay.id)
        if (room === null) throw new Error('falta sala')
        const settled = room.settleDeadlines(new Date(TOURNAMENT_AT.getTime() + offset), new Map())
        await fresh.rooms.save(settled, room.version)
      }
    }
    expect(fresh.accounts.getBattleProfile).not.toHaveBeenCalled()
    expect(fresh.heroes.getEquippedHero).not.toHaveBeenCalled()
    const afterFinish = await reconnect()
    for (const [i, request] of [e1, e2].entries()) {
      const replay = await afterFinish.create(request)
      expect(replay.id).toBe(i === 0 ? room1.id : room2.id)
      expect((await afterFinish.start(replay.id, request)).status).toBe('FINISHED')
      const isolated = await replayInFreshProcess(request)
      expect(isolated.replay).toMatchObject({ id: replay.id, status: 'FINISHED' })
      expect(isolated.start).toMatchObject({ id: replay.id, status: 'FINISHED' })
      expect(isolated.record.result?.participants).toHaveLength(6)
      const record = await new GetTournamentRoomRecord(afterFinish.rooms).execute(replay.id, 0)
      expect(record.result).toMatchObject({ outcome: 'NO_WINNER', reason: 'TIME_LIMIT' })
      expect(record.teams.flatMap((team) => team.participants)).toHaveLength(6)
      expect(record.events.items.map((event) => event.seq)).toEqual(
        Array.from({ length: 13 }, (_, i) => i + 1),
      )
      await expect(
        afterFinish.create({ ...request, mode: 'DUO', teamSize: 2 }),
      ).rejects.toBeInstanceOf(TournamentRoomOperationReusedError)
    }
  })

  it('el motor rechaza duplicar operacion, roster parcial, IA, humanos repetidos y metadatos contradictorios', async () => {
    const h = tournamentHarness(new MongoBattleRoomRepository(db))
    const created = await h.create(tournamentRequest('TRIO', 'schema'))
    const collection = db.collection<Record<string, unknown> & { _id: string }>('battle-rooms')
    const document = await collection.findOne({ _id: created.id })
    if (document === null) throw new Error('falta documento')
    await expect(collection.insertOne({ ...document, _id: randomUUID() })).rejects.toMatchObject({
      code: 11000,
    })
    const teams = document.teams as {
      label: string
      capacity: number
      participants: Record<string, unknown>[]
    }[]
    const metadata = document.tournament as Record<string, unknown>
    const variants = [
      { tournament: { ...metadata, teamSize: 2 } },
      { teams: [{ ...teams[0], participants: teams[0]!.participants.slice(0, 2) }, teams[1]] },
      {
        teams: [
          {
            ...teams[0],
            participants: [
              { ...teams[0]!.participants[0], kind: 'AI', playerId: null },
              ...teams[0]!.participants.slice(1),
            ],
          },
          teams[1],
        ],
      },
      {
        teams: [
          {
            ...teams[0],
            participants: [teams[1]!.participants[0], ...teams[0]!.participants.slice(1)],
          },
          teams[1],
        ],
      },
    ]
    for (const [i, variant] of variants.entries()) {
      const operationId = `invalid-schema-${String(i)}`
      await expect(
        collection.insertOne({
          ...document,
          _id: randomUUID(),
          ...variant,
          tournament: { ...metadata, ...(variant.tournament ?? {}), operationId },
        }),
      ).rejects.toMatchObject({ code: 121 })
    }
  })
})
