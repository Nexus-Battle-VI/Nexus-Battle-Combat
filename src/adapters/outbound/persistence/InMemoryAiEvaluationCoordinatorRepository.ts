import type {
  AiEvaluationCoordinatorPort,
  AiEvaluationDecisionParams,
  AiEvaluationLeaseClaim,
  AiEvaluationLedgerArtifactInfo,
  AiEvaluationLedgerSnapshot,
  AiModelRollbackAuditEvent,
} from '../../../application/ports/AiEvaluationCoordinatorPort'
import { AiEvaluationLineageConflictError } from '../../../application/errors/AiEvaluationErrors'

interface MutableLedgerState {
  modelVersion: string
  trainingRunId: string
  modelStateSha256: string
  onnxArtifactSha256: string
  parityReferenceSha256: string
  leaseState: 'IDLE' | 'CLAIMED'
  leaseOwnerId: string | null
  fencingToken: number
  leaseExpiresAt: Date | null
  status: AiEvaluationLedgerSnapshot['status']
  evaluationId: string | null
  evaluationOutcome: AiEvaluationLedgerSnapshot['evaluationOutcome']
  gateResults: readonly unknown[]
  failureReasons: readonly string[]
  previousActiveVersion: string | null
  previousActiveRevision: number | null
  promotionStatus: AiEvaluationLedgerSnapshot['promotionStatus']
  promotionPolicyVersion: string | null
  evaluationConfigVersion: string | null
  sourceCommit: string | null
  seedSetSha256: string | null
  matchesSha256: string | null
  evaluationConfigSha256: string | null
  evaluationProtocolSha256: string | null
  candidateSummarySha256: string | null
  activeBaselineSummarySha256: string | null
  consecutiveFailureCount: number
  evaluatedAt: Date | null
  rollbackHistory: readonly unknown[]
}

const toSnapshot = (state: MutableLedgerState): AiEvaluationLedgerSnapshot => ({ ...state })

/** Respaldo en memoria (`PERSISTENCE_DRIVER=memory`), mismo contrato que `MongoAiEvaluationCoordinatorRepository`. */
export class InMemoryAiEvaluationCoordinatorRepository implements AiEvaluationCoordinatorPort {
  private readonly rows = new Map<string, MutableLedgerState>()

  ensureAndTryClaim(
    modelVersion: string,
    artifact: AiEvaluationLedgerArtifactInfo,
    ownerId: string,
    leaseDurationMs: number,
    at: Date,
  ): Promise<AiEvaluationLeaseClaim | null> {
    let row = this.rows.get(modelVersion)
    if (row === undefined) {
      row = {
        modelVersion,
        trainingRunId: artifact.trainingRunId,
        modelStateSha256: artifact.modelStateSha256,
        onnxArtifactSha256: artifact.onnxArtifactSha256,
        parityReferenceSha256: artifact.parityReferenceSha256,
        leaseState: 'IDLE',
        leaseOwnerId: null,
        fencingToken: 0,
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
        consecutiveFailureCount: 0,
        evaluatedAt: null,
        rollbackHistory: [],
      }
      this.rows.set(modelVersion, row)
    } else if (
      row.trainingRunId !== artifact.trainingRunId ||
      row.modelStateSha256 !== artifact.modelStateSha256 ||
      row.onnxArtifactSha256 !== artifact.onnxArtifactSha256 ||
      row.parityReferenceSha256 !== artifact.parityReferenceSha256
    ) {
      return Promise.reject(new AiEvaluationLineageConflictError(modelVersion))
    }

    const leaseIsFree =
      row.leaseState === 'IDLE' ||
      (row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() < at.getTime())
    if (!leaseIsFree) return Promise.resolve(null)

    row.leaseState = 'CLAIMED'
    row.leaseOwnerId = ownerId
    row.leaseExpiresAt = new Date(at.getTime() + leaseDurationMs)
    row.fencingToken += 1
    return Promise.resolve({ modelVersion, ownerId, fencingToken: row.fencingToken })
  }

  renewLease(claim: AiEvaluationLeaseClaim, leaseDurationMs: number, at: Date): Promise<boolean> {
    const row = this.owned(claim)
    if (row === null) return Promise.resolve(false)
    row.leaseExpiresAt = new Date(at.getTime() + leaseDurationMs)
    return Promise.resolve(true)
  }

  releaseLease(claim: AiEvaluationLeaseClaim): Promise<void> {
    const row = this.owned(claim)
    if (row !== null) {
      row.leaseState = 'IDLE'
      row.leaseOwnerId = null
      row.leaseExpiresAt = null
    }
    return Promise.resolve()
  }

  markEvaluating(claim: AiEvaluationLeaseClaim): Promise<boolean> {
    const row = this.owned(claim)
    if (row === null) return Promise.resolve(false)
    row.status = 'EVALUATING'
    return Promise.resolve(true)
  }

  recordDecision(params: AiEvaluationDecisionParams): Promise<boolean> {
    const row = this.owned(params.claim)
    if (row === null) return Promise.resolve(false)
    row.status = 'DECIDED'
    row.evaluationId = params.evaluationId
    row.evaluationOutcome = params.evaluationOutcome
    row.gateResults = params.gateResults
    row.failureReasons = params.failureReasons
    row.previousActiveVersion = params.previousActiveVersion
    row.previousActiveRevision = params.previousActiveRevision
    row.promotionStatus = params.evaluationOutcome === 'PASS' ? 'NOT_STARTED' : 'NOT_APPLICABLE'
    row.promotionPolicyVersion = params.promotionPolicyVersion
    row.evaluationConfigVersion = params.evaluationConfigVersion
    row.sourceCommit = params.sourceCommit
    row.seedSetSha256 = params.seedSetSha256
    row.matchesSha256 = params.matchesSha256
    row.evaluationConfigSha256 = params.evaluationConfigSha256
    row.evaluationProtocolSha256 = params.evaluationProtocolSha256
    row.candidateSummarySha256 = params.candidateSummarySha256
    row.activeBaselineSummarySha256 = params.activeBaselineSummarySha256
    row.consecutiveFailureCount = 0
    row.evaluatedAt = params.at
    return Promise.resolve(true)
  }

  recordInfrastructureFailure(claim: AiEvaluationLeaseClaim, reason: string): Promise<boolean> {
    const row = this.owned(claim)
    if (row === null) return Promise.resolve(false)
    row.leaseState = 'IDLE'
    row.leaseOwnerId = null
    row.leaseExpiresAt = null
    row.failureReasons = [reason]
    row.consecutiveFailureCount += 1
    return Promise.resolve(true)
  }

  markPromotionStatus(
    claim: AiEvaluationLeaseClaim,
    promotionStatus: AiEvaluationLedgerSnapshot['promotionStatus'],
  ): Promise<boolean> {
    const row = this.owned(claim)
    if (row === null) return Promise.resolve(false)
    row.promotionStatus = promotionStatus
    return Promise.resolve(true)
  }

  appendRollbackEvent(
    modelVersion: string,
    event: AiModelRollbackAuditEvent,
    at: Date,
  ): Promise<void> {
    const row = this.rows.get(modelVersion)
    if (
      row !== undefined &&
      !row.rollbackHistory.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'rollbackId' in entry &&
          entry.rollbackId === event.rollbackId,
      )
    ) {
      row.rollbackHistory = [...row.rollbackHistory, { ...event, at }]
    }
    return Promise.resolve()
  }

  getByModelVersion(modelVersion: string): Promise<AiEvaluationLedgerSnapshot | null> {
    const row = this.rows.get(modelVersion)
    return Promise.resolve(row === undefined ? null : toSnapshot(row))
  }

  private owned(claim: AiEvaluationLeaseClaim): MutableLedgerState | null {
    const row = this.rows.get(claim.modelVersion)
    if (row === undefined) return null
    if (row.leaseOwnerId !== claim.ownerId || row.fencingToken !== claim.fencingToken) return null
    return row
  }
}
