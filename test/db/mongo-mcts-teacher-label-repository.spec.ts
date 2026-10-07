import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import {
  MCTS_TEACHER_LABELS_COLLECTION,
  MongoMctsTeacherLabelRepository,
} from '../../src/adapters/outbound/persistence/MongoMctsTeacherLabelRepository'
import { toMctsTeacherLabelDocument } from '../../src/adapters/outbound/persistence/mcts-teacher-label-mapping'
import { MctsTeacherLabelConflictError } from '../../src/domain/errors/MctsErrors'
import {
  MCTS_TEACHER_LABEL_SCHEMA_VERSION,
  type MctsTeacherLabel,
} from '../../src/domain/decision/MctsTeacherLabel'
import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

type RawLabelDocument = Record<string, unknown> & { readonly _id: string }

describe('MongoMctsTeacherLabelRepository (EN-036.2 #566, correccion de alcance sobre PR#81)', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient | undefined
  let db: Db | undefined

  beforeAll(async () => {
    const externalUri = process.env.MONGO_TEST_URI
    if (externalUri === undefined) container = await new MongoDBContainer('mongo:8.0').start()
    const options = {
      uri: externalUri ?? `${container!.getConnectionString()}/?directConnection=true`,
      databaseName: `mcts_teacher_labels_${String(Date.now())}`,
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

  const action = {
    kind: 'BASIC_ATTACK' as const,
    target: { scope: 'COMBATANT' as const, combatant: { teamLabel: 'B', seat: 0 } },
  }

  const label = (overrides: Partial<MctsTeacherLabel> = {}): MctsTeacherLabel => ({
    schemaVersion: MCTS_TEACHER_LABEL_SCHEMA_VERSION,
    eventId: 'decision:ONLINE:db-label-room:cmd-db',
    battleId: 'db-label-room',
    decisionSequence: 0,
    origin: 'ONLINE',
    mode: 'PVE',
    result: {
      config: MCTS_TEACHER_V1_CONFIG,
      simulationSeed: 42,
      stateSchemaVersion: 1,
      selectedAction: action,
      candidates: [
        {
          action,
          actionIdentity: 'BASIC_ATTACK|COMBATANT|1:B|0',
          visits: 128,
          meanUtility: 0.6,
          probability: 1,
        },
      ],
    },
    generatedAt: new Date('2026-10-06T12:00:00.000Z'),
    ...overrides,
  })

  it('registers migration 025 after the frozen migration history', () => {
    expect(MIGRATIONS.at(-1)?.name).toBe('025-mcts-teacher-labels')
  })

  it('creates the append-only index on battleId/decisionSequence', async () => {
    const indexes = await db!.collection(MCTS_TEACHER_LABELS_COLLECTION).indexes()

    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(['_id_', 'battle_decision_sequence_unique', 'generated_at']),
    )
    expect(indexes.find((index) => index.name === 'battle_decision_sequence_unique')).toMatchObject(
      { unique: true, key: { battleId: 1, decisionSequence: 1 } },
    )
  })

  it('persists and finds a label by eventId', async () => {
    const repository = new MongoMctsTeacherLabelRepository(db!)
    await repository.append(
      label({ eventId: 'decision:ONLINE:find-room:cmd-find', battleId: 'find-room' }),
    )

    const found = await repository.findByEventId('decision:ONLINE:find-room:cmd-find')
    expect(found).toMatchObject({ battleId: 'find-room', decisionSequence: 0 })
    expect(found?.generatedAt).toBeInstanceOf(Date)
  })

  it('repeating the SAME label content under the same eventId is idempotent', async () => {
    const repository = new MongoMctsTeacherLabelRepository(db!)
    const event = label({
      eventId: 'decision:ONLINE:idempotent-room:cmd-idempotent',
      battleId: 'idempotent-room',
    })

    await repository.append(event)
    await expect(repository.append(event)).resolves.toBeUndefined()
  })

  it('a divergent payload under the same eventId rejects with MctsTeacherLabelConflictError', async () => {
    const repository = new MongoMctsTeacherLabelRepository(db!)
    const event = label({
      eventId: 'decision:ONLINE:conflict-room:cmd-conflict',
      battleId: 'conflict-room',
    })
    await repository.append(event)

    await expect(
      repository.append({ ...event, result: { ...event.result, simulationSeed: 999 } }),
    ).rejects.toBeInstanceOf(MctsTeacherLabelConflictError)
  })

  it('enforces the collection validator instead of accepting an unversioned document', async () => {
    await expect(
      db!
        .collection<{ _id: string; battleId: string }>(MCTS_TEACHER_LABELS_COLLECTION)
        .insertOne({ _id: 'invalid-label', battleId: 'invalid-battle' }),
    ).rejects.toMatchObject({ code: 121 })
  })

  // NOTA: "actionIdentity coincide con su action real" es una regla SEMANTICA
  // (comprobada en LiveMctsTeacherLabeler.validate(), ya cubierto en
  // mcts-teacher-label.spec.ts), no algo que `$jsonSchema` pueda expresar --
  // un validador Mongo solo comprueba forma/tipo/rango, nunca "este campo
  // debe ser funcion de aquel otro". Por eso ese caso no aparece aqui.
  it.each([
    [
      'a probability outside [0,1]',
      (document: RawLabelDocument): RawLabelDocument => ({
        ...document,
        result: {
          ...(document.result as Record<string, unknown>),
          candidates: [
            {
              ...(document.result as { candidates: Record<string, unknown>[] }).candidates[0],
              probability: 1.5,
            },
          ],
        },
      }),
    ],
    [
      'an unexpected top-level property',
      (document: RawLabelDocument): RawLabelDocument => ({
        ...document,
        jwt: 'must-never-enter-the-dataset',
      }),
    ],
  ])('rejects %s at the database boundary', async (_label, corrupt) => {
    const battleId = `invalid-room-${_label.replace(/[^a-z0-9]+/gi, '-')}`
    const valid = toMctsTeacherLabelDocument(
      label({ eventId: `decision:ONLINE:${battleId}:cmd`, battleId }),
    )

    await expect(
      db!.collection<RawLabelDocument>(MCTS_TEACHER_LABELS_COLLECTION).insertOne(corrupt(valid)),
    ).rejects.toMatchObject({ code: 121 })
  })
})
