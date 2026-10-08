import type {
  ContinuousTrainingCoordinatorPort,
  ContinuousTrainingCoordinatorSnapshot,
  ContinuousTrainingFailureReasonCode,
  ContinuousTrainingRunOutcome,
  TrainingLeaseClaim,
} from '../../../application/ports/ContinuousTrainingCoordinatorPort'

interface State {
  requestedThrough: Date
  processedThrough: Date
  leaseState: 'IDLE' | 'CLAIMED'
  leaseOwnerId: string | null
  fencingToken: number
  leaseExpiresAt: Date | null
  lastRunOutcome: ContinuousTrainingRunOutcome | null
  lastRunAt: Date | null
  lastRunModelVersion: string | null
  consecutiveFailureCount: number
}

/** Respaldo en memoria, mismo contrato que `MongoContinuousTrainingCoordinatorRepository` -- para pruebas rapidas de la logica del worker (#571) sin Mongo real. */
export class InMemoryContinuousTrainingCoordinatorRepository implements ContinuousTrainingCoordinatorPort {
  private state: State = {
    requestedThrough: new Date(0),
    processedThrough: new Date(0),
    leaseState: 'IDLE',
    leaseOwnerId: null,
    fencingToken: 0,
    leaseExpiresAt: null,
    lastRunOutcome: null,
    lastRunAt: null,
    lastRunModelVersion: null,
    consecutiveFailureCount: 0,
  }

  advanceRequestedThrough(candidateThrough: Date): Promise<void> {
    if (candidateThrough.getTime() > this.state.requestedThrough.getTime()) {
      this.state.requestedThrough = candidateThrough
    }
    return Promise.resolve()
  }

  getSnapshot(): Promise<ContinuousTrainingCoordinatorSnapshot> {
    return Promise.resolve({
      requestedThrough: this.state.requestedThrough,
      processedThrough: this.state.processedThrough,
      leaseState: this.state.leaseState,
      consecutiveFailureCount: this.state.consecutiveFailureCount,
      lastRunOutcome: this.state.lastRunOutcome,
      lastRunAt: this.state.lastRunAt,
      lastRunModelVersion: this.state.lastRunModelVersion,
    })
  }

  tryClaimLease(
    ownerId: string,
    leaseDurationMs: number,
    at: Date,
  ): Promise<TrainingLeaseClaim | null> {
    const expired =
      this.state.leaseExpiresAt !== null && this.state.leaseExpiresAt.getTime() < at.getTime()
    if (this.state.leaseState !== 'IDLE' && !expired) {
      return Promise.resolve(null)
    }
    this.state.leaseState = 'CLAIMED'
    this.state.leaseOwnerId = ownerId
    this.state.fencingToken += 1
    this.state.leaseExpiresAt = new Date(at.getTime() + leaseDurationMs)
    return Promise.resolve({ ownerId, fencingToken: this.state.fencingToken })
  }

  renewLease(claim: TrainingLeaseClaim, leaseDurationMs: number, at: Date): Promise<boolean> {
    if (!this.owns(claim)) return Promise.resolve(false)
    this.state.leaseExpiresAt = new Date(at.getTime() + leaseDurationMs)
    return Promise.resolve(true)
  }

  releaseLease(claim: TrainingLeaseClaim): Promise<void> {
    if (this.owns(claim)) this.release()
    return Promise.resolve()
  }

  recordSuccess(
    claim: TrainingLeaseClaim,
    processedThrough: Date,
    modelVersion: string,
    at: Date,
  ): Promise<boolean> {
    if (!this.owns(claim)) return Promise.resolve(false)
    this.state.processedThrough = processedThrough
    this.state.lastRunOutcome = 'SUCCESS'
    this.state.lastRunAt = at
    this.state.lastRunModelVersion = modelVersion
    this.state.consecutiveFailureCount = 0
    this.release()
    return Promise.resolve(true)
  }

  recordNotTrainable(
    claim: TrainingLeaseClaim,
    processedThrough: Date,
    _reason: string,
    at: Date,
  ): Promise<boolean> {
    if (!this.owns(claim)) return Promise.resolve(false)
    this.state.processedThrough = processedThrough
    this.state.lastRunOutcome = 'NOT_TRAINABLE'
    this.state.lastRunAt = at
    this.state.lastRunModelVersion = null
    this.state.consecutiveFailureCount = 0
    this.release()
    return Promise.resolve(true)
  }

  recordNotTrainableRetry(claim: TrainingLeaseClaim, _reason: string, at: Date): Promise<boolean> {
    if (!this.owns(claim)) return Promise.resolve(false)
    this.state.lastRunOutcome = 'NOT_TRAINABLE'
    this.state.lastRunAt = at
    this.state.lastRunModelVersion = null
    this.state.consecutiveFailureCount += 1
    this.release()
    return Promise.resolve(true)
  }

  recordFailure(
    claim: TrainingLeaseClaim,
    _reasonCode: ContinuousTrainingFailureReasonCode,
    _reason: string,
    at: Date,
  ): Promise<boolean> {
    if (!this.owns(claim)) return Promise.resolve(false)
    this.state.lastRunOutcome = 'FAILED'
    this.state.lastRunAt = at
    this.state.lastRunModelVersion = null
    this.state.consecutiveFailureCount += 1
    this.release()
    return Promise.resolve(true)
  }

  /**
   * SOLO para pruebas (#571): simula que otro propietario reclamo el lease
   * (p. ej. tras una expiracion real) sin tener que esperar un timeout de
   * verdad -- nunca se usa fuera de `test/`.
   */
  __testOnlyForceReclaim(ownerId: string): void {
    this.state.leaseState = 'CLAIMED'
    this.state.leaseOwnerId = ownerId
    this.state.fencingToken += 1
  }

  private owns(claim: TrainingLeaseClaim): boolean {
    return (
      this.state.leaseOwnerId === claim.ownerId && this.state.fencingToken === claim.fencingToken
    )
  }

  private release(): void {
    this.state.leaseState = 'IDLE'
    this.state.leaseOwnerId = null
    this.state.leaseExpiresAt = null
  }
}
