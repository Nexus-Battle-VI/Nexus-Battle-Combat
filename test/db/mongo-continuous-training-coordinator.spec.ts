import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { MongoContinuousTrainingCoordinatorRepository } from '../../src/adapters/outbound/persistence/MongoContinuousTrainingCoordinatorRepository'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

const AT = new Date('2027-01-01T00:00:00.000Z')
const LATER = new Date('2027-01-01T00:10:00.000Z')

/**
 * Pruebas contra Mongo REAL (EN-037.2, Management #571 §6, §12 CT-07..11):
 * el lease/fencing distribuido SOLO se demuestra de verdad contra el motor
 * -- no existe en Combat ningun lock reutilizable en memoria que sirva
 * aqui (`ChannelLock` es de una sola replica, ADR-020).
 */
describe('ContinuousTrainingCoordinator sobre MongoDB real (EN-037.2, Management #571)', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient | undefined
  let db: Db | undefined

  beforeAll(async () => {
    const externalUri = process.env.MONGO_TEST_URI
    if (externalUri === undefined) container = await new MongoDBContainer('mongo:8.0').start()
    const options = {
      uri: externalUri ?? `${container!.getConnectionString()}/?directConnection=true`,
      databaseName: `ai_training_coordinator_${String(Date.now())}`,
    }
    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
  }, 120_000)

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
    await container?.stop()
  })

  const newCoordinator = (): MongoContinuousTrainingCoordinatorRepository =>
    new MongoContinuousTrainingCoordinatorRepository(db!)

  it('registers migration 028 right after 027-ai-model-registry', () => {
    expect(MIGRATIONS.slice(26, 28).map((migration) => migration.name)).toEqual([
      '027-ai-model-registry',
      '028-ai-training-coordinator',
    ])
  })

  it('starts IDLE with cursor at the epoch', async () => {
    const coordinator = newCoordinator()
    const snapshot = await coordinator.getSnapshot()
    expect(snapshot.leaseState).toBe('IDLE')
    expect(snapshot.requestedThrough.getTime()).toBe(0)
    expect(snapshot.processedThrough.getTime()).toBe(0)
  })

  it('advanceRequestedThrough only ever moves forward ($max), never backward', async () => {
    const coordinator = newCoordinator()
    await coordinator.advanceRequestedThrough(new Date('2027-02-01T00:00:00.000Z'), AT)
    await coordinator.advanceRequestedThrough(new Date('2027-01-15T00:00:00.000Z'), AT)

    const snapshot = await coordinator.getSnapshot()
    expect(snapshot.requestedThrough).toEqual(new Date('2027-02-01T00:00:00.000Z'))
  })

  it('CT-07: two concurrent claim attempts, only one gets a valid lease', async () => {
    const coordinatorA = newCoordinator()
    const coordinatorB = newCoordinator()

    const [claimA, claimB] = await Promise.all([
      coordinatorA.tryClaimLease('worker-a', 60_000, AT),
      coordinatorB.tryClaimLease('worker-b', 60_000, AT),
    ])

    const claims = [claimA, claimB].filter((claim) => claim !== null)
    expect(claims).toHaveLength(1)

    // Limpieza para no interferir con las pruebas siguientes.
    const winner = claims[0]!
    await coordinatorA.releaseLease(winner, LATER)
  })

  it('a second claim attempt while a valid lease is held returns null', async () => {
    const coordinator = newCoordinator()
    const claim = await coordinator.tryClaimLease('worker-solo', 60_000, AT)
    expect(claim).not.toBeNull()

    const secondAttempt = await coordinator.tryClaimLease('worker-intruder', 60_000, AT)
    expect(secondAttempt).toBeNull()

    await coordinator.releaseLease(claim!, LATER)
  })

  it('CT-09: an EXPIRED lease can be reclaimed by a different owner', async () => {
    const coordinator = newCoordinator()
    const firstClaim = await coordinator.tryClaimLease('worker-expired', 1_000, AT)
    expect(firstClaim).not.toBeNull()

    const muchLater = new Date(AT.getTime() + 60_000)
    const secondClaim = await coordinator.tryClaimLease('worker-recovers', 60_000, muchLater)
    expect(secondClaim).not.toBeNull()
    expect(secondClaim!.fencingToken).toBeGreaterThan(firstClaim!.fencingToken)

    await coordinator.releaseLease(secondClaim!, LATER)
  })

  it('CT-08/CT-10: renewLease fails once the lease has been reclaimed by another owner (fencing)', async () => {
    const coordinator = newCoordinator()
    const staleClaim = await coordinator.tryClaimLease('worker-stale', 1_000, AT)
    expect(staleClaim).not.toBeNull()

    const muchLater = new Date(AT.getTime() + 60_000)
    const reclaimedBySomeoneElse = await coordinator.tryClaimLease(
      'worker-new-owner',
      60_000,
      muchLater,
    )
    expect(reclaimedBySomeoneElse).not.toBeNull()

    // El propietario obsoleto intenta renovar con su fencing token viejo: rechazado.
    const renewed = await coordinator.renewLease(staleClaim!, 60_000, muchLater)
    expect(renewed).toBe(false)

    await coordinator.releaseLease(reclaimedBySomeoneElse!, LATER)
  })

  it('CT-11: a stale owner can NEVER record a result after losing the lease', async () => {
    const coordinator = newCoordinator()
    const staleClaim = await coordinator.tryClaimLease('worker-will-lose-lease', 1_000, AT)
    expect(staleClaim).not.toBeNull()

    const muchLater = new Date(AT.getTime() + 60_000)
    const newOwnerClaim = await coordinator.tryClaimLease('worker-takes-over', 60_000, muchLater)
    expect(newOwnerClaim).not.toBeNull()

    const staleRecorded = await coordinator.recordSuccess(
      staleClaim!,
      muchLater,
      'candidate-mlp-v1-stale-should-never-land',
      muchLater,
    )
    expect(staleRecorded).toBe(false)

    const snapshotAfterStaleAttempt = await coordinator.getSnapshot()
    expect(snapshotAfterStaleAttempt.lastRunModelVersion).not.toBe(
      'candidate-mlp-v1-stale-should-never-land',
    )

    const realRecorded = await coordinator.recordSuccess(
      newOwnerClaim!,
      muchLater,
      'candidate-mlp-v1-real-owner',
      muchLater,
    )
    expect(realRecorded).toBe(true)
  })

  it('recordFailure never advances processedThrough and increments consecutiveFailureCount', async () => {
    const coordinator = newCoordinator()
    const before = await coordinator.getSnapshot()
    const claim = await coordinator.tryClaimLease('worker-failure', 60_000, AT)
    expect(claim).not.toBeNull()

    const recorded = await coordinator.recordFailure(
      claim!,
      'TRAINING_PROCESS_FAILED',
      'simulacion de fallo tecnico',
      LATER,
    )
    expect(recorded).toBe(true)

    const after = await coordinator.getSnapshot()
    expect(after.processedThrough).toEqual(before.processedThrough)
    expect(after.consecutiveFailureCount).toBe(before.consecutiveFailureCount + 1)
    expect(after.leaseState).toBe('IDLE')
    expect(after.lastRunOutcome).toBe('FAILED')
  })

  it('recordNotTrainable advances processedThrough but never registers a model version', async () => {
    const coordinator = newCoordinator()
    const claim = await coordinator.tryClaimLease('worker-not-trainable', 60_000, AT)
    expect(claim).not.toBeNull()

    const cutoff = new Date('2027-03-01T00:00:00.000Z')
    const recorded = await coordinator.recordNotTrainable(
      claim!,
      cutoff,
      'train_decisions=0',
      LATER,
    )
    expect(recorded).toBe(true)

    const snapshot = await coordinator.getSnapshot()
    expect(snapshot.processedThrough).toEqual(cutoff)
    expect(snapshot.lastRunOutcome).toBe('NOT_TRAINABLE')
    expect(snapshot.leaseState).toBe('IDLE')
  })

  it('revision de codigo (#571 §7.3): recordNotTrainableRetry increments the backoff counter without ever advancing processedThrough', async () => {
    const coordinator = newCoordinator()
    const before = await coordinator.getSnapshot()
    const claim = await coordinator.tryClaimLease('worker-not-trainable-retry', 60_000, AT)
    expect(claim).not.toBeNull()

    const recorded = await coordinator.recordNotTrainableRetry(
      claim!,
      'labels todavia en vuelo',
      LATER,
    )
    expect(recorded).toBe(true)

    const snapshot = await coordinator.getSnapshot()
    expect(snapshot.processedThrough).toEqual(before.processedThrough)
    expect(snapshot.lastRunOutcome).toBe('NOT_TRAINABLE')
    expect(snapshot.leaseState).toBe('IDLE')
    expect(snapshot.consecutiveFailureCount).toBe(before.consecutiveFailureCount + 1)
  })

  it('revision de codigo (#571 §6.2): a stale owner can never record recordNotTrainableRetry either (same fencing as recordSuccess/recordFailure)', async () => {
    const coordinator = newCoordinator()
    const staleClaim = await coordinator.tryClaimLease('worker-stale-not-trainable', 1_000, AT)
    expect(staleClaim).not.toBeNull()

    const muchLater = new Date(AT.getTime() + 60_000)
    const newOwnerClaim = await coordinator.tryClaimLease(
      'worker-new-owner-not-trainable',
      60_000,
      muchLater,
    )
    expect(newOwnerClaim).not.toBeNull()

    const staleRecorded = await coordinator.recordNotTrainableRetry(
      staleClaim!,
      'intento obsoleto',
      muchLater,
    )
    expect(staleRecorded).toBe(false)

    await coordinator.releaseLease(newOwnerClaim!, muchLater)
  })

  it('a direct insert bypassing the repository (invalid leaseState) is rejected by the Mongo validator', async () => {
    await expect(
      db!.collection('ai-training-coordinator').insertOne({
        _id: 'a-second-singleton-is-itself-invalid-usage-but-this-tests-the-field-enum',
        schemaVersion: 1,
        requestedThrough: AT,
        processedThrough: AT,
        leaseState: 'NOT_A_REAL_STATE',
        leaseOwnerId: null,
        fencingToken: 0,
        claimedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastRunOutcome: null,
        lastRunAt: null,
        lastRunModelVersion: null,
        lastFailureReasonCode: null,
        lastFailureReason: null,
        consecutiveFailureCount: 0,
        createdAt: AT,
        updatedAt: AT,
      } as never),
    ).rejects.toMatchObject({ code: 121 })
  })
})
