import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import {
  MISSION_SIMULATION_INTAKE_COLLECTION,
  MongoMissionSimulationIntakeRepository,
} from '../../src/adapters/outbound/persistence/MongoMissionSimulationIntakeRepository'
import { AcceptMissionSimulationRequest } from '../../src/application/use-cases/AcceptMissionSimulationRequest'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

describe('MongoMissionSimulationIntakeRepository', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db

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
  }, 120_000)

  afterAll(async () => {
    await client.close()
    await container.stop()
  })

  it('registers migration 014 after experience rolls', () => {
    expect(MIGRATIONS.at(-1)?.name).toBe('015-mission-simulation-results')
  })

  it('stores one durable fingerprint and rejects a conflicting retry after restart', async () => {
    const operationId = 'mission:enr-durable:simulate'
    const first = new AcceptMissionSimulationRequest(new MongoMissionSimulationIntakeRepository(db))
    await first.execute(operationId, 'a'.repeat(64))

    const afterRestart = new AcceptMissionSimulationRequest(
      new MongoMissionSimulationIntakeRepository(db),
    )
    await expect(afterRestart.execute(operationId, 'a'.repeat(64))).resolves.toBeUndefined()
    await expect(afterRestart.execute(operationId, 'b'.repeat(64))).rejects.toMatchObject({
      name: 'MissionSimulationOperationReusedError',
    })
    expect(
      await db
        .collection<{ _id: string }>(MISSION_SIMULATION_INTAKE_COLLECTION)
        .countDocuments({ _id: operationId }),
    ).toBe(1)
  })

  it('does not overwrite the winning body when two requests race for the same key', async () => {
    const operationId = 'mission:enr-concurrent:simulate'
    const first = new AcceptMissionSimulationRequest(new MongoMissionSimulationIntakeRepository(db))
    const second = new AcceptMissionSimulationRequest(
      new MongoMissionSimulationIntakeRepository(db),
    )
    const outcomes = await Promise.allSettled([
      first.execute(operationId, 'a'.repeat(64)),
      second.execute(operationId, 'b'.repeat(64)),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { name: 'MissionSimulationOperationReusedError' },
    })
    expect(
      await db
        .collection<{ _id: string }>(MISSION_SIMULATION_INTAKE_COLLECTION)
        .countDocuments({ _id: operationId }),
    ).toBe(1)
  })
})
