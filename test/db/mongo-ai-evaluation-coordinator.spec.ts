import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { MongoAiEvaluationCoordinatorRepository } from '../../src/adapters/outbound/persistence/MongoAiEvaluationCoordinatorRepository'
import { AiEvaluationLineageConflictError } from '../../src/application/errors/AiEvaluationErrors'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

const AT = new Date('2027-02-01T00:00:00.000Z')
const LATER = new Date('2027-02-01T00:10:00.000Z')
const hex = (digit: string): string => digit.repeat(64)

const artifact = {
  trainingRunId: 'candidate-mlp-v1-abc123',
  modelStateSha256: hex('1'),
  onnxArtifactSha256: hex('2'),
  parityReferenceSha256: hex('3'),
}

/**
 * Pruebas contra Mongo REAL (EN-037.3, Management #572 §7.3, §13): el
 * lease/fencing distribuido por candidato solo se demuestra de verdad
 * contra el motor, mismo criterio que `mongo-continuous-training-coordinator.spec.ts` (#571).
 */
describe('AiEvaluationCoordinator sobre MongoDB real (EN-037.3, Management #572)', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient | undefined
  let db: Db | undefined

  beforeAll(async () => {
    const externalUri = process.env.MONGO_TEST_URI
    if (externalUri === undefined) container = await new MongoDBContainer('mongo:8.0').start()
    const options = {
      uri: externalUri ?? `${container!.getConnectionString()}/?directConnection=true`,
      databaseName: `ai_evaluation_coordinator_${String(Date.now())}`,
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

  const newCoordinator = (): MongoAiEvaluationCoordinatorRepository =>
    new MongoAiEvaluationCoordinatorRepository(db!)

  it('registers migration 030 right after 029', () => {
    expect(MIGRATIONS.slice(28, 30).map((migration) => migration.name)).toEqual([
      '029-ai-model-registry-promotion-fields',
      '030-ai-evaluation-coordinator',
    ])
  })

  it('ensureAndTryClaim creates the ledger row on first sight and claims it', async () => {
    const coordinator = newCoordinator()
    const claim = await coordinator.ensureAndTryClaim('m-1', artifact, 'worker-a', 60_000, AT)
    expect(claim).not.toBeNull()

    const snapshot = await coordinator.getByModelVersion('m-1')
    expect(snapshot?.leaseState).toBe('CLAIMED')
    expect(snapshot?.status).toBe('PENDING')
    expect(snapshot?.trainingRunId).toBe(artifact.trainingRunId)

    await coordinator.releaseLease(claim!, LATER)
  })

  it('a second ensureAndTryClaim while the lease is held returns null, never a second claim', async () => {
    const coordinator = newCoordinator()
    const first = await coordinator.ensureAndTryClaim('m-2', artifact, 'worker-a', 60_000, AT)
    expect(first).not.toBeNull()

    const second = await coordinator.ensureAndTryClaim('m-2', artifact, 'worker-b', 60_000, AT)
    expect(second).toBeNull()

    await coordinator.releaseLease(first!, LATER)
  })

  it('fails closed when the same modelVersion is presented with different artifact lineage', async () => {
    const coordinator = newCoordinator()
    const first = await coordinator.ensureAndTryClaim(
      'm-lineage-conflict',
      artifact,
      'worker-a',
      60_000,
      AT,
    )
    await coordinator.releaseLease(first!, AT)

    await expect(
      coordinator.ensureAndTryClaim(
        'm-lineage-conflict',
        { ...artifact, onnxArtifactSha256: hex('9') },
        'worker-b',
        60_000,
        LATER,
      ),
    ).rejects.toBeInstanceOf(AiEvaluationLineageConflictError)
  })

  it('an EXPIRED lease can be reclaimed by a different owner, fencing token strictly increases', async () => {
    const coordinator = newCoordinator()
    const first = await coordinator.ensureAndTryClaim('m-3', artifact, 'worker-expired', 1_000, AT)
    expect(first).not.toBeNull()

    const muchLater = new Date(AT.getTime() + 60_000)
    const second = await coordinator.ensureAndTryClaim(
      'm-3',
      artifact,
      'worker-recovers',
      60_000,
      muchLater,
    )
    expect(second).not.toBeNull()
    expect(second!.fencingToken).toBeGreaterThan(first!.fencingToken)

    await coordinator.releaseLease(second!, muchLater)
  })

  it('a stale owner can never recordDecision after losing the lease (fencing)', async () => {
    const coordinator = newCoordinator()
    const stale = await coordinator.ensureAndTryClaim('m-4', artifact, 'worker-stale', 1_000, AT)
    expect(stale).not.toBeNull()

    const muchLater = new Date(AT.getTime() + 60_000)
    const newOwner = await coordinator.ensureAndTryClaim(
      'm-4',
      artifact,
      'worker-new-owner',
      60_000,
      muchLater,
    )
    expect(newOwner).not.toBeNull()

    const staleRecorded = await coordinator.recordDecision({
      claim: stale!,
      evaluationId: 'eval-stale',
      evaluationOutcome: 'PASS',
      gateResults: [],
      failureReasons: [],
      previousActiveVersion: null,
      previousActiveRevision: null,
      promotionPolicyVersion: 'promotion-policy-v1',
      evaluationConfigVersion: 'evaluation-config-v1',
      sourceCommit: 'abc123',
      seedSetSha256: hex('5'),
      matchesSha256: hex('6'),
      evaluationConfigSha256: hex('7'),
      evaluationProtocolSha256: hex('8'),
      candidateSummarySha256: hex('9'),
      activeBaselineSummarySha256: null,
      at: muchLater,
    })
    expect(staleRecorded).toBe(false)

    const snapshot = await coordinator.getByModelVersion('m-4')
    expect(snapshot?.evaluationId).not.toBe('eval-stale')

    await coordinator.releaseLease(newOwner!, muchLater)
  })

  it('recordDecision PASS sets promotionStatus=NOT_STARTED; FAIL sets NOT_APPLICABLE', async () => {
    const coordinator = newCoordinator()

    const passClaim = await coordinator.ensureAndTryClaim('m-pass', artifact, 'worker', 60_000, AT)
    await coordinator.recordDecision({
      claim: passClaim!,
      evaluationId: 'eval-pass',
      evaluationOutcome: 'PASS',
      gateResults: [{ gate: 'SAFETY', passed: true }],
      failureReasons: [],
      previousActiveVersion: 'm-0',
      previousActiveRevision: 4,
      promotionPolicyVersion: 'promotion-policy-v1',
      evaluationConfigVersion: 'evaluation-config-v1',
      sourceCommit: 'abc123',
      seedSetSha256: hex('5'),
      matchesSha256: hex('6'),
      evaluationConfigSha256: hex('7'),
      evaluationProtocolSha256: hex('8'),
      candidateSummarySha256: hex('9'),
      activeBaselineSummarySha256: hex('a'),
      at: LATER,
    })
    const passSnapshot = await coordinator.getByModelVersion('m-pass')
    expect(passSnapshot?.promotionStatus).toBe('NOT_STARTED')
    expect(passSnapshot?.status).toBe('DECIDED')
    expect(passSnapshot?.leaseState).toBe('CLAIMED')

    const failClaim = await coordinator.ensureAndTryClaim('m-fail', artifact, 'worker', 60_000, AT)
    await coordinator.recordDecision({
      claim: failClaim!,
      evaluationId: 'eval-fail',
      evaluationOutcome: 'FAIL',
      gateResults: [{ gate: 'SAFETY', passed: false }],
      failureReasons: ['SAFETY: fake failure'],
      previousActiveVersion: null,
      previousActiveRevision: null,
      promotionPolicyVersion: 'promotion-policy-v1',
      evaluationConfigVersion: 'evaluation-config-v1',
      sourceCommit: 'abc123',
      seedSetSha256: hex('5'),
      matchesSha256: hex('6'),
      evaluationConfigSha256: hex('7'),
      evaluationProtocolSha256: hex('8'),
      candidateSummarySha256: hex('9'),
      activeBaselineSummarySha256: null,
      at: LATER,
    })
    const failSnapshot = await coordinator.getByModelVersion('m-fail')
    expect(failSnapshot?.promotionStatus).toBe('NOT_APPLICABLE')
  })

  it('recordInfrastructureFailure never writes evaluationOutcome, only increments consecutiveFailureCount', async () => {
    const coordinator = newCoordinator()
    const claim = await coordinator.ensureAndTryClaim('m-infra', artifact, 'worker', 60_000, AT)
    expect(claim).not.toBeNull()

    const recorded = await coordinator.recordInfrastructureFailure(
      claim!,
      'harness no arranco',
      LATER,
    )
    expect(recorded).toBe(true)

    const snapshot = await coordinator.getByModelVersion('m-infra')
    expect(snapshot?.evaluationOutcome).toBeNull()
    expect(snapshot?.consecutiveFailureCount).toBe(1)
    expect(snapshot?.leaseState).toBe('IDLE')
  })

  it('markPromotionStatus exige el mismo lease/fencing hasta completar la promocion', async () => {
    const coordinator = newCoordinator()
    const claim = await coordinator.ensureAndTryClaim('m-promo', artifact, 'worker', 60_000, AT)
    await coordinator.recordDecision({
      claim: claim!,
      evaluationId: 'eval-promo',
      evaluationOutcome: 'PASS',
      gateResults: [],
      failureReasons: [],
      previousActiveVersion: null,
      previousActiveRevision: null,
      promotionPolicyVersion: 'promotion-policy-v1',
      evaluationConfigVersion: 'evaluation-config-v1',
      sourceCommit: 'abc123',
      seedSetSha256: hex('5'),
      matchesSha256: hex('6'),
      evaluationConfigSha256: hex('7'),
      evaluationProtocolSha256: hex('8'),
      candidateSummarySha256: hex('9'),
      activeBaselineSummarySha256: null,
      at: LATER,
    })

    await coordinator.markPromotionStatus(claim!, 'IN_PROGRESS', LATER)
    expect((await coordinator.getByModelVersion('m-promo'))?.promotionStatus).toBe('IN_PROGRESS')

    await coordinator.markPromotionStatus(claim!, 'COMPLETED', LATER)
    expect((await coordinator.getByModelVersion('m-promo'))?.promotionStatus).toBe('COMPLETED')

    await coordinator.releaseLease(claim!, LATER)
    const successor = await coordinator.ensureAndTryClaim(
      'm-promo',
      artifact,
      'worker-successor',
      60_000,
      new Date(LATER.getTime() + 1),
    )
    expect(successor).not.toBeNull()
    await expect(
      coordinator.markPromotionStatus(claim!, 'IN_PROGRESS', new Date(LATER.getTime() + 2)),
    ).resolves.toBe(false)
    await coordinator.releaseLease(successor!, new Date(LATER.getTime() + 3))

    await coordinator.appendRollbackEvent(
      'm-promo',
      {
        rollbackId: 'rollback-db-test-1',
        fromVersion: 'm-promo-next',
        reason: 'rollback de prueba',
      },
      LATER,
    )
    await coordinator.appendRollbackEvent(
      'm-promo',
      {
        rollbackId: 'rollback-db-test-1',
        fromVersion: 'm-promo-next',
        reason: 'rollback de prueba',
      },
      LATER,
    )
    const snapshot = await coordinator.getByModelVersion('m-promo')
    expect(snapshot?.rollbackHistory).toHaveLength(1)
  })

  it('a direct insert bypassing the repository (invalid status) is rejected by the Mongo validator', async () => {
    await expect(
      db!.collection('ai-model-evaluations').insertOne({
        _id: 'invalid-status-doc',
        schemaVersion: 1,
        trainingRunId: artifact.trainingRunId,
        modelStateSha256: artifact.modelStateSha256,
        onnxArtifactSha256: artifact.onnxArtifactSha256,
        parityReferenceSha256: artifact.parityReferenceSha256,
        leaseState: 'IDLE',
        leaseOwnerId: null,
        fencingToken: 0,
        claimedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        status: 'NOT_A_REAL_STATUS',
        evaluationId: null,
        evaluationOutcome: null,
        gateResults: [],
        failureReasons: [],
        previousActiveVersion: null,
        promotionStatus: 'NOT_APPLICABLE',
        promotionPolicyVersion: null,
        evaluationConfigVersion: null,
        sourceCommit: null,
        seedSetSha256: null,
        matchesSha256: null,
        evaluationConfigSha256: null,
        consecutiveFailureCount: 0,
        evaluatedAt: null,
        rollbackHistory: [],
        createdAt: AT,
        updatedAt: AT,
      } as never),
    ).rejects.toMatchObject({ code: 121 })
  })
})
