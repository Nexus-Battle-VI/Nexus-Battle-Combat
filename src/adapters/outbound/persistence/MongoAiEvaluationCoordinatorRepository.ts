import { Int32, type Collection, type Db } from 'mongodb'

import type {
  AiEvaluationCoordinatorPort,
  AiEvaluationDecisionParams,
  AiEvaluationLeaseClaim,
  AiEvaluationLedgerArtifactInfo,
  AiEvaluationLedgerSnapshot,
  AiEvaluationOutcome,
  AiEvaluationPromotionStatus,
  AiModelRollbackAuditEvent,
} from '../../../application/ports/AiEvaluationCoordinatorPort'
import { AiEvaluationLineageConflictError } from '../../../application/errors/AiEvaluationErrors'

export const AI_MODEL_EVALUATIONS_COLLECTION = 'ai-model-evaluations'

interface EvaluationDocument {
  readonly _id: string
  readonly schemaVersion: number
  readonly trainingRunId: string
  readonly modelStateSha256: string
  readonly onnxArtifactSha256: string
  readonly parityReferenceSha256: string
  readonly leaseState: 'IDLE' | 'CLAIMED'
  readonly leaseOwnerId: string | null
  readonly fencingToken: Int32
  readonly claimedAt: Date | null
  readonly heartbeatAt: Date | null
  readonly leaseExpiresAt: Date | null
  readonly status: 'PENDING' | 'EVALUATING' | 'DECIDED'
  readonly evaluationId: string | null
  readonly evaluationOutcome: AiEvaluationOutcome | null
  readonly gateResults: readonly unknown[]
  readonly failureReasons: readonly string[]
  readonly previousActiveVersion: string | null
  readonly previousActiveRevision: Int32 | null
  readonly promotionStatus: AiEvaluationPromotionStatus
  readonly promotionPolicyVersion: string | null
  readonly evaluationConfigVersion: string | null
  readonly sourceCommit: string | null
  readonly seedSetSha256: string | null
  readonly matchesSha256: string | null
  readonly evaluationConfigSha256: string | null
  readonly evaluationProtocolSha256: string | null
  readonly candidateSummarySha256: string | null
  readonly activeBaselineSummarySha256: string | null
  readonly consecutiveFailureCount: Int32
  readonly evaluatedAt: Date | null
  readonly rollbackHistory: readonly unknown[]
  readonly createdAt: Date
  readonly updatedAt: Date
}

const releasedLeaseFields = {
  leaseState: 'IDLE' as const,
  leaseOwnerId: null,
  claimedAt: null,
  heartbeatAt: null,
  leaseExpiresAt: null,
}

const toSnapshot = (document: EvaluationDocument): AiEvaluationLedgerSnapshot => ({
  modelVersion: document._id,
  trainingRunId: document.trainingRunId,
  modelStateSha256: document.modelStateSha256,
  onnxArtifactSha256: document.onnxArtifactSha256,
  parityReferenceSha256: document.parityReferenceSha256,
  leaseState: document.leaseState,
  status: document.status,
  evaluationId: document.evaluationId,
  evaluationOutcome: document.evaluationOutcome,
  gateResults: document.gateResults,
  failureReasons: document.failureReasons,
  previousActiveVersion: document.previousActiveVersion,
  previousActiveRevision: document.previousActiveRevision?.valueOf() ?? null,
  promotionStatus: document.promotionStatus,
  promotionPolicyVersion: document.promotionPolicyVersion,
  evaluationConfigVersion: document.evaluationConfigVersion,
  sourceCommit: document.sourceCommit,
  seedSetSha256: document.seedSetSha256,
  matchesSha256: document.matchesSha256,
  evaluationConfigSha256: document.evaluationConfigSha256,
  evaluationProtocolSha256: document.evaluationProtocolSha256,
  candidateSummarySha256: document.candidateSummarySha256,
  activeBaselineSummarySha256: document.activeBaselineSummarySha256,
  consecutiveFailureCount: document.consecutiveFailureCount.valueOf(),
  evaluatedAt: document.evaluatedAt,
  rollbackHistory: document.rollbackHistory,
})

/**
 * Coordinacion de la evaluacion automatica sobre MongoDB (EN-037.3,
 * Management #572 §7.3, §13). `ensureAndTryClaim` es DELIBERADAMENTE dos
 * escrituras (insercion idempotente del renglon, despues reclamo atomico
 * del lease) en vez de un unico `findOneAndUpdate` con `upsert` -- un
 * `upsert` cuyo filtro usa `$or` no fija de forma fiable los campos del
 * documento NUEVO cuando no existia todavia (Mongo solo copia
 * condiciones de IGUALDAD del filtro al insertar, nunca las ramas de un
 * `$or`), exactamente el motivo por el que #571 nunca necesito resolver
 * esto: su documento siempre existe desde la migracion 028. Aqui cada
 * `modelVersion` es un documento nuevo, asi que la insercion inicial debe
 * ser explicita.
 */
export class MongoAiEvaluationCoordinatorRepository implements AiEvaluationCoordinatorPort {
  private readonly evaluations: Collection<EvaluationDocument>

  constructor(db: Db) {
    this.evaluations = db.collection<EvaluationDocument>(AI_MODEL_EVALUATIONS_COLLECTION)
  }

  async ensureAndTryClaim(
    modelVersion: string,
    artifact: AiEvaluationLedgerArtifactInfo,
    ownerId: string,
    leaseDurationMs: number,
    at: Date,
  ): Promise<AiEvaluationLeaseClaim | null> {
    try {
      await this.evaluations.insertOne({
        _id: modelVersion,
        schemaVersion: 1,
        trainingRunId: artifact.trainingRunId,
        modelStateSha256: artifact.modelStateSha256,
        onnxArtifactSha256: artifact.onnxArtifactSha256,
        parityReferenceSha256: artifact.parityReferenceSha256,
        leaseState: 'IDLE',
        leaseOwnerId: null,
        fencingToken: new Int32(0),
        claimedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        status: 'PENDING',
        evaluationId: null,
        evaluationOutcome: null,
        gateResults: [],
        failureReasons: [],
        previousActiveVersion: null,
        previousActiveRevision: null,
        promotionStatus: 'NOT_APPLICABLE',
        promotionPolicyVersion: null,
        evaluationConfigVersion: null,
        sourceCommit: null,
        seedSetSha256: null,
        matchesSha256: null,
        evaluationConfigSha256: null,
        evaluationProtocolSha256: null,
        candidateSummarySha256: null,
        activeBaselineSummarySha256: null,
        consecutiveFailureCount: new Int32(0),
        evaluatedAt: null,
        rollbackHistory: [],
        createdAt: at,
        updatedAt: at,
      })
    } catch (error: unknown) {
      const isDuplicateKey =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 11000
      if (!isDuplicateKey) throw error
      // Ya existia (otro coordinador lo vio primero, o es un reintento): continuar al reclamo del lease.
    }

    const existing = await this.evaluations.findOne(
      { _id: modelVersion },
      {
        projection: {
          trainingRunId: 1,
          modelStateSha256: 1,
          onnxArtifactSha256: 1,
          parityReferenceSha256: 1,
        },
      },
    )
    if (
      existing?.trainingRunId !== artifact.trainingRunId ||
      existing.modelStateSha256 !== artifact.modelStateSha256 ||
      existing.onnxArtifactSha256 !== artifact.onnxArtifactSha256 ||
      existing.parityReferenceSha256 !== artifact.parityReferenceSha256
    ) {
      throw new AiEvaluationLineageConflictError(modelVersion)
    }

    const leaseExpiresAt = new Date(at.getTime() + leaseDurationMs)
    const result = await this.evaluations.findOneAndUpdate(
      {
        _id: modelVersion,
        $or: [{ leaseState: 'IDLE' }, { leaseExpiresAt: { $lt: at } }],
      },
      {
        $set: {
          leaseState: 'CLAIMED',
          leaseOwnerId: ownerId,
          claimedAt: at,
          heartbeatAt: at,
          leaseExpiresAt,
          updatedAt: at,
        },
        $inc: { fencingToken: new Int32(1) },
      },
      { returnDocument: 'after' },
    )
    if (result === null) return null
    return { modelVersion, ownerId, fencingToken: result.fencingToken.valueOf() }
  }

  async renewLease(
    claim: AiEvaluationLeaseClaim,
    leaseDurationMs: number,
    at: Date,
  ): Promise<boolean> {
    const leaseExpiresAt = new Date(at.getTime() + leaseDurationMs)
    const result = await this.evaluations.updateOne(this.ownedByFilter(claim), {
      $set: { heartbeatAt: at, leaseExpiresAt, updatedAt: at },
    })
    return result.matchedCount === 1
  }

  async releaseLease(claim: AiEvaluationLeaseClaim, at: Date): Promise<void> {
    await this.evaluations.updateOne(this.ownedByFilter(claim), {
      $set: { ...releasedLeaseFields, updatedAt: at },
    })
  }

  async markEvaluating(claim: AiEvaluationLeaseClaim, at: Date): Promise<boolean> {
    const result = await this.evaluations.updateOne(this.ownedByFilter(claim), {
      $set: { status: 'EVALUATING', updatedAt: at },
    })
    return result.matchedCount === 1
  }

  async recordDecision(params: AiEvaluationDecisionParams): Promise<boolean> {
    const result = await this.evaluations.updateOne(this.ownedByFilter(params.claim), {
      $set: {
        status: 'DECIDED',
        evaluationId: params.evaluationId,
        evaluationOutcome: params.evaluationOutcome,
        gateResults: params.gateResults,
        failureReasons: params.failureReasons,
        previousActiveVersion: params.previousActiveVersion,
        previousActiveRevision:
          params.previousActiveRevision === null ? null : new Int32(params.previousActiveRevision),
        promotionStatus: params.evaluationOutcome === 'PASS' ? 'NOT_STARTED' : 'NOT_APPLICABLE',
        promotionPolicyVersion: params.promotionPolicyVersion,
        evaluationConfigVersion: params.evaluationConfigVersion,
        sourceCommit: params.sourceCommit,
        seedSetSha256: params.seedSetSha256,
        matchesSha256: params.matchesSha256,
        evaluationConfigSha256: params.evaluationConfigSha256,
        evaluationProtocolSha256: params.evaluationProtocolSha256,
        candidateSummarySha256: params.candidateSummarySha256,
        activeBaselineSummarySha256: params.activeBaselineSummarySha256,
        consecutiveFailureCount: new Int32(0),
        evaluatedAt: params.at,
        updatedAt: params.at,
      },
    })
    return result.matchedCount === 1
  }

  async recordInfrastructureFailure(
    claim: AiEvaluationLeaseClaim,
    reason: string,
    at: Date,
  ): Promise<boolean> {
    const result = await this.evaluations.updateOne(this.ownedByFilter(claim), {
      $set: {
        ...releasedLeaseFields,
        failureReasons: [reason],
        updatedAt: at,
      },
      $inc: { consecutiveFailureCount: new Int32(1) },
    })
    return result.matchedCount === 1
  }

  async markPromotionStatus(
    claim: AiEvaluationLeaseClaim,
    promotionStatus: AiEvaluationPromotionStatus,
    at: Date,
  ): Promise<boolean> {
    const result = await this.evaluations.updateOne(this.ownedByFilter(claim), {
      $set: { promotionStatus, updatedAt: at },
    })
    return result.matchedCount === 1
  }

  async appendRollbackEvent(
    modelVersion: string,
    event: AiModelRollbackAuditEvent,
    at: Date,
  ): Promise<void> {
    await this.evaluations.updateOne(
      { _id: modelVersion, 'rollbackHistory.rollbackId': { $ne: event.rollbackId } },
      {
        $push: { rollbackHistory: { ...event, at } },
        $set: { updatedAt: at },
      },
    )
  }

  async getByModelVersion(modelVersion: string): Promise<AiEvaluationLedgerSnapshot | null> {
    const document = await this.evaluations.findOne({ _id: modelVersion })
    return document === null ? null : toSnapshot(document)
  }

  private ownedByFilter(claim: AiEvaluationLeaseClaim): Record<string, unknown> {
    return {
      _id: claim.modelVersion,
      leaseOwnerId: claim.ownerId,
      fencingToken: new Int32(claim.fencingToken),
    }
  }
}
