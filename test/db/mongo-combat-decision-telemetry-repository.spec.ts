import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import {
  COMBAT_DECISION_EVENTS_COLLECTION,
  MongoCombatDecisionTelemetryRepository,
} from '../../src/adapters/outbound/persistence/MongoCombatDecisionTelemetryRepository'
import { toCombatDecisionTelemetryDocument } from '../../src/adapters/outbound/persistence/combat-decision-event-mapping'
import { Sha256CommandIdFingerprint } from '../../src/adapters/outbound/system/Sha256CommandIdFingerprint'
import { CombatDecisionTelemetryConflictError } from '../../src/application/ports/CombatDecisionTelemetryRepositoryPort'
import { CombatDecisionRecorder } from '../../src/application/services/CombatDecisionRecorder'
import { battleWithCombat } from '../fixtures/basic-attack'
import { ROOM_ID } from '../fixtures/battle'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

type RawTelemetryDocument = Record<string, unknown> & { readonly _id: string }

describe('MongoCombatDecisionTelemetryRepository', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient | undefined
  let db: Db | undefined

  beforeAll(async () => {
    const externalUri = process.env.MONGO_TEST_URI
    if (externalUri === undefined) container = await new MongoDBContainer('mongo:8.0').start()
    const options = {
      uri: externalUri ?? `${container!.getConnectionString()}/?directConnection=true`,
      databaseName: `combat_decisions_${String(Date.now())}`,
    }
    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migración falló.')
    }
  }, 120_000)

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
    await container?.stop()
  })

  const recorder = (): CombatDecisionRecorder =>
    new CombatDecisionRecorder(
      new MongoCombatDecisionTelemetryRepository(db!),
      { now: () => new Date('2026-10-04T12:00:00.000Z') },
      { error: jest.fn() },
      new Sha256CommandIdFingerprint(),
    )

  const decision = (commandId = 'cmd-db') =>
    recorder().prepareHumanDecision(battleWithCombat(), commandId, {
      kind: 'BASIC_ATTACK',
      target: { scope: 'COMBATANT', combatant: { teamLabel: 'B', seat: 0 } },
    })

  it('registers migration 023 after the frozen migration history', () => {
    expect(MIGRATIONS.at(-1)?.name).toBe('023-combat-decision-events')
  })

  it('creates the append-only indexes required for identity and versioned dataset reads', async () => {
    const indexes = await db!.collection(COMBAT_DECISION_EVENTS_COLLECTION).indexes()

    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        '_id_',
        'decision_sequence_unique',
        'outcome_unique',
        'schema_occurred_at',
      ]),
    )
    expect(indexes.find((index) => index.name === 'schema_occurred_at')?.key).toEqual({
      schemaVersion: 1,
      occurredAt: 1,
    })
  })

  it('persists, orders and replays the same semantic event after a repository restart', async () => {
    const first = decision('cmd-db-first')
    const second = { ...decision('cmd-db-second'), decisionSequence: 1 }
    const repository = new MongoCombatDecisionTelemetryRepository(db!)

    await repository.append(second)
    await repository.append(first)
    await repository.append({ ...first, occurredAt: new Date('2030-01-01T00:00:00.000Z') })

    const afterRestart = new MongoCombatDecisionTelemetryRepository(db!)
    const stored = await afterRestart.listDecisionsByBattle('ONLINE', ROOM_ID)
    expect(stored.map((event) => event.decisionSequence)).toEqual([0, 1])
    expect(stored[0]?.occurredAt).toBeInstanceOf(Date)
  })

  it('rejects a divergent payload under the same event id', async () => {
    const event = {
      ...decision('cmd-db-conflict'),
      eventId: 'decision:ONLINE:db-conflict-room:cmd-db-conflict',
      battleId: 'db-conflict-room',
    }
    const repository = new MongoCombatDecisionTelemetryRepository(db!)
    await repository.append(event)

    await expect(repository.append({ ...event, decisionSource: 'MCTS' })).rejects.toBeInstanceOf(
      CombatDecisionTelemetryConflictError,
    )
  })

  it('stores at most one terminal outcome per origin and battle', async () => {
    const service = recorder()
    const repository = new MongoCombatDecisionTelemetryRepository(db!)
    const outcome = service.prepareOutcome({
      origin: 'TOURNAMENT',
      battleId: 'tournament-room-db',
      mode: 'PVP',
      outcome: {
        kind: 'BATTLE',
        reason: 'ELIMINATION',
        outcome: 'WIN',
        winnerTeamLabel: 'A',
      },
    })

    await repository.append(outcome)
    await repository.append({ ...outcome, occurredAt: new Date('2030-01-01T00:00:00.000Z') })

    await expect(repository.findOutcome('TOURNAMENT', 'tournament-room-db')).resolves.toMatchObject(
      { eventId: outcome.eventId },
    )
  })

  it('enforces the collection validator instead of accepting an unversioned document', async () => {
    await expect(
      db!
        .collection<{ _id: string; eventType: string; battleId: string }>(
          COMBAT_DECISION_EVENTS_COLLECTION,
        )
        .insertOne({
          _id: 'invalid-event',
          eventType: 'COMBAT_DECISION',
          battleId: 'invalid-battle',
        }),
    ).rejects.toMatchObject({ code: 121 })
  })

  it.each([
    [
      'unknown selected action discriminators',
      (document: RawTelemetryDocument): RawTelemetryDocument => ({
        ...document,
        selectedAction: { kind: 'HACK', playerId: 'persona@example.com' },
      }),
    ],
    [
      'unexpected state properties',
      (document: RawTelemetryDocument): RawTelemetryDocument => ({
        ...document,
        stateBefore: {
          ...(document.stateBefore as Record<string, unknown>),
          jwt: 'must-never-enter-the-dataset',
        },
      }),
    ],
  ])('rejects %s at the database boundary', async (_label, corrupt) => {
    const valid = toCombatDecisionTelemetryDocument(decision(`cmd-invalid-${_label}`))

    await expect(
      db!
        .collection<RawTelemetryDocument>(COMBAT_DECISION_EVENTS_COLLECTION)
        .insertOne(corrupt(valid)),
    ).rejects.toMatchObject({ code: 121 })
  })

  it('rejects unexpected outcome fields at the database boundary', async () => {
    const outcome = recorder().prepareOutcome({
      origin: 'ONLINE',
      battleId: 'invalid-outcome-shape',
      mode: 'PVP',
      outcome: {
        kind: 'BATTLE',
        reason: 'ELIMINATION',
        outcome: 'WIN',
        winnerTeamLabel: 'A',
      },
    })
    const valid = toCombatDecisionTelemetryDocument(outcome)

    await expect(
      db!.collection<RawTelemetryDocument>(COMBAT_DECISION_EVENTS_COLLECTION).insertOne({
        ...valid,
        outcome: { ...outcome.outcome, playerId: 'must-not-be-persisted' },
      }),
    ).rejects.toMatchObject({ code: 121 })
  })
})
