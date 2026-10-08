import { Int32, type Collection, type Db } from 'mongodb'

import type {
  ContinuousTrainingCoordinatorPort,
  ContinuousTrainingCoordinatorSnapshot,
  ContinuousTrainingFailureReasonCode,
  ContinuousTrainingRunOutcome,
  TrainingLeaseClaim,
} from '../../../application/ports/ContinuousTrainingCoordinatorPort'
import { AI_TRAINING_COORDINATOR_DOC_ID } from './migrations/028-ai-training-coordinator'

export const AI_TRAINING_COORDINATOR_COLLECTION = 'ai-training-coordinator'

interface CoordinatorDocument {
  readonly _id: string
  readonly schemaVersion: number
  readonly requestedThrough: Date
  readonly processedThrough: Date
  readonly leaseState: 'IDLE' | 'CLAIMED'
  readonly leaseOwnerId: string | null
  readonly fencingToken: Int32
  readonly claimedAt: Date | null
  readonly heartbeatAt: Date | null
  readonly leaseExpiresAt: Date | null
  readonly lastRunOutcome: ContinuousTrainingRunOutcome | null
  readonly lastRunAt: Date | null
  readonly lastRunModelVersion: string | null
  readonly lastFailureReasonCode: ContinuousTrainingFailureReasonCode | null
  readonly lastFailureReason: string | null
  readonly consecutiveFailureCount: Int32
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

/**
 * Coordinacion del worker de reentrenamiento continuo sobre MongoDB
 * (EN-037.2, Management #571 §6): cada operacion es UNA escritura atomica
 * sobre el documento singleton (`findOneAndUpdate`/`updateOne` con filtro
 * de propiedad+fencing) -- nunca dos escrituras que podrian dejar el
 * cursor y el lease inconsistentes entre si.
 */
export class MongoContinuousTrainingCoordinatorRepository implements ContinuousTrainingCoordinatorPort {
  private readonly coordinator: Collection<CoordinatorDocument>

  constructor(db: Db) {
    this.coordinator = db.collection<CoordinatorDocument>(AI_TRAINING_COORDINATOR_COLLECTION)
  }

  async advanceRequestedThrough(candidateThrough: Date, at: Date): Promise<void> {
    await this.coordinator.updateOne(
      { _id: AI_TRAINING_COORDINATOR_DOC_ID },
      { $max: { requestedThrough: candidateThrough }, $set: { updatedAt: at } },
    )
  }

  async getSnapshot(): Promise<ContinuousTrainingCoordinatorSnapshot> {
    const document = await this.coordinator.findOne({ _id: AI_TRAINING_COORDINATOR_DOC_ID })
    if (document === null) {
      throw new Error(
        `No existe el documento de coordinacion "${AI_TRAINING_COORDINATOR_DOC_ID}": ` +
          'falta aplicar la migracion 028-ai-training-coordinator.',
      )
    }
    return {
      requestedThrough: document.requestedThrough,
      processedThrough: document.processedThrough,
      leaseState: document.leaseState,
      consecutiveFailureCount: document.consecutiveFailureCount.valueOf(),
      lastRunOutcome: document.lastRunOutcome,
      lastRunAt: document.lastRunAt,
      lastRunModelVersion: document.lastRunModelVersion,
    }
  }

  async tryClaimLease(
    ownerId: string,
    leaseDurationMs: number,
    at: Date,
  ): Promise<TrainingLeaseClaim | null> {
    const leaseExpiresAt = new Date(at.getTime() + leaseDurationMs)
    const result = await this.coordinator.findOneAndUpdate(
      {
        _id: AI_TRAINING_COORDINATOR_DOC_ID,
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
    return { ownerId, fencingToken: result.fencingToken.valueOf() }
  }

  async renewLease(claim: TrainingLeaseClaim, leaseDurationMs: number, at: Date): Promise<boolean> {
    const leaseExpiresAt = new Date(at.getTime() + leaseDurationMs)
    const result = await this.coordinator.updateOne(this.ownedByFilter(claim), {
      $set: { heartbeatAt: at, leaseExpiresAt, updatedAt: at },
    })
    return result.matchedCount === 1
  }

  async releaseLease(claim: TrainingLeaseClaim, at: Date): Promise<void> {
    await this.coordinator.updateOne(this.ownedByFilter(claim), {
      $set: { ...releasedLeaseFields, updatedAt: at },
    })
  }

  async recordSuccess(
    claim: TrainingLeaseClaim,
    processedThrough: Date,
    modelVersion: string,
    at: Date,
  ): Promise<boolean> {
    const result = await this.coordinator.updateOne(this.ownedByFilter(claim), {
      $set: {
        ...releasedLeaseFields,
        processedThrough,
        lastRunOutcome: 'SUCCESS',
        lastRunAt: at,
        lastRunModelVersion: modelVersion,
        lastFailureReasonCode: null,
        lastFailureReason: null,
        consecutiveFailureCount: new Int32(0),
        updatedAt: at,
      },
    })
    return result.matchedCount === 1
  }

  async recordNotTrainable(
    claim: TrainingLeaseClaim,
    processedThrough: Date,
    reason: string,
    at: Date,
  ): Promise<boolean> {
    const result = await this.coordinator.updateOne(this.ownedByFilter(claim), {
      $set: {
        ...releasedLeaseFields,
        processedThrough,
        lastRunOutcome: 'NOT_TRAINABLE',
        lastRunAt: at,
        lastRunModelVersion: null,
        lastFailureReasonCode: null,
        lastFailureReason: reason,
        consecutiveFailureCount: new Int32(0),
        updatedAt: at,
      },
    })
    return result.matchedCount === 1
  }

  async recordNotTrainableRetry(
    claim: TrainingLeaseClaim,
    reason: string,
    at: Date,
  ): Promise<boolean> {
    const result = await this.coordinator.updateOne(this.ownedByFilter(claim), {
      $set: {
        ...releasedLeaseFields,
        lastRunOutcome: 'NOT_TRAINABLE',
        lastRunAt: at,
        lastRunModelVersion: null,
        lastFailureReasonCode: null,
        lastFailureReason: reason,
        updatedAt: at,
      },
      $inc: { consecutiveFailureCount: new Int32(1) },
    })
    return result.matchedCount === 1
  }

  async recordFailure(
    claim: TrainingLeaseClaim,
    reasonCode: ContinuousTrainingFailureReasonCode,
    reason: string,
    at: Date,
  ): Promise<boolean> {
    const result = await this.coordinator.updateOne(this.ownedByFilter(claim), {
      $set: {
        ...releasedLeaseFields,
        lastRunOutcome: 'FAILED',
        lastRunAt: at,
        lastRunModelVersion: null,
        lastFailureReasonCode: reasonCode,
        lastFailureReason: reason,
        updatedAt: at,
      },
      $inc: { consecutiveFailureCount: new Int32(1) },
    })
    return result.matchedCount === 1
  }

  private ownedByFilter(claim: TrainingLeaseClaim): Record<string, unknown> {
    return {
      _id: AI_TRAINING_COORDINATOR_DOC_ID,
      leaseOwnerId: claim.ownerId,
      fencingToken: new Int32(claim.fencingToken),
    }
  }
}
