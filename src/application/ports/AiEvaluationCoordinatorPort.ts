/**
 * Puerto de coordinacion de la evaluacion automatica (EN-037.3, Management
 * #572 §7.3, §13): UN documento por candidato (`modelVersion`), nunca un
 * singleton global como `ContinuousTrainingCoordinatorPort` (#571) -- a
 * diferencia del cursor continuo de batallas, el trabajo de #572 ya esta
 * partido de forma natural por `modelVersion` (cada `CANDIDATE` es su
 * propia unidad de trabajo). Reutiliza el MISMO patron atomico de
 * lease/fencing que #571, en una coleccion propia (revision de codigo de
 * #571, P1-3: reusar el singleton del trainer habria acoplado semantica
 * de cursor de entrenamiento con semantica de evaluacion).
 *
 * Este documento es TAMBIEN el ledger de evidencia y auditoria exigido
 * por #572 §7.6/§12: cada decision de promocion/rechazo debe poder
 * reconstruirse sin depender solo de logs.
 */

export type AiEvaluationOutcome = 'PASS' | 'FAIL' | 'INFRASTRUCTURE_FAILURE'
export type AiEvaluationPromotionStatus =
  'NOT_APPLICABLE' | 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'

export interface AiEvaluationLeaseClaim {
  readonly modelVersion: string
  readonly ownerId: string
  readonly fencingToken: number
}

export interface AiEvaluationLedgerSnapshot {
  readonly modelVersion: string
  readonly trainingRunId: string
  readonly modelStateSha256: string
  readonly onnxArtifactSha256: string
  readonly parityReferenceSha256: string
  readonly leaseState: 'IDLE' | 'CLAIMED'
  readonly status: 'PENDING' | 'EVALUATING' | 'DECIDED'
  readonly evaluationId: string | null
  readonly evaluationOutcome: AiEvaluationOutcome | null
  readonly gateResults: readonly unknown[]
  readonly failureReasons: readonly string[]
  readonly previousActiveVersion: string | null
  readonly promotionStatus: AiEvaluationPromotionStatus
  readonly promotionPolicyVersion: string | null
  readonly evaluationConfigVersion: string | null
  readonly sourceCommit: string | null
  readonly seedSetSha256: string | null
  readonly matchesSha256: string | null
  readonly evaluationConfigSha256: string | null
  readonly consecutiveFailureCount: number
  readonly evaluatedAt: Date | null
  readonly rollbackHistory: readonly unknown[]
}

export interface AiEvaluationLedgerArtifactInfo {
  readonly trainingRunId: string
  readonly modelStateSha256: string
  readonly onnxArtifactSha256: string
  readonly parityReferenceSha256: string
}

export interface AiModelRollbackAuditEvent {
  /** Idempotency key supplied by the protected CLI/operator workflow. */
  readonly rollbackId: string
  readonly fromVersion: string
  readonly reason: string
}

export interface AiEvaluationDecisionParams {
  readonly claim: AiEvaluationLeaseClaim
  readonly evaluationId: string
  readonly evaluationOutcome: 'PASS' | 'FAIL'
  readonly gateResults: readonly unknown[]
  readonly failureReasons: readonly string[]
  readonly previousActiveVersion: string | null
  readonly promotionPolicyVersion: string
  readonly evaluationConfigVersion: string
  readonly sourceCommit: string
  readonly seedSetSha256: string
  readonly matchesSha256: string
  readonly evaluationConfigSha256: string
  readonly at: Date
}

export interface AiEvaluationCoordinatorPort {
  /**
   * Garantiza que exista un renglon del ledger para `modelVersion` (crea
   * uno nuevo en `PENDING`/`IDLE` si es la primera vez que se ve este
   * candidato; no-op si ya existe) y despues intenta reclamar el lease de
   * forma atomica. `null` si el lease ya esta en manos de otro
   * propietario vigente (no expirado).
   */
  ensureAndTryClaim(
    modelVersion: string,
    artifact: AiEvaluationLedgerArtifactInfo,
    ownerId: string,
    leaseDurationMs: number,
    at: Date,
  ): Promise<AiEvaluationLeaseClaim | null>

  /** `false` si el fencing token ya no coincide (lease perdido, otro propietario reclamo mientras tanto). */
  renewLease(claim: AiEvaluationLeaseClaim, leaseDurationMs: number, at: Date): Promise<boolean>

  /** Libera el lease sin registrar ningun resultado (p.ej. tras un fallo de infraestructura ya registrado por `recordInfrastructureFailure`). */
  releaseLease(claim: AiEvaluationLeaseClaim, at: Date): Promise<void>

  /**
   * Transicion `PENDING -> EVALUATING`/marca de progreso (#572 §7.2):
   * permite distinguir, en recuperacion, un candidato que nunca empezo a
   * evaluarse de uno que SI empezo pero el proceso murio a mitad de
   * camino. `false` si el lease ya no es vigente (fencing).
   */
  markEvaluating(claim: AiEvaluationLeaseClaim, at: Date): Promise<boolean>

  /**
   * Persiste la decision FINAL de `PromotionPolicyV1` (PASS o FAIL) y
   * libera el lease. `promotionStatus` pasa a `NOT_STARTED` si PASS (el
   * `AutomaticModelEvaluationCoordinator` todavia debe ejecutar
   * `AiModelRegistry.promoteEvaluatedCandidate`), o a `NOT_APPLICABLE` si
   * FAIL. `false` si el fencing token ya no coincide.
   */
  recordDecision(params: AiEvaluationDecisionParams): Promise<boolean>

  /**
   * Un fallo TECNICO (harness no arranco, Mongo no respondio, proceso
   * caido) NUNCA se confunde con un fallo real de gates (#572 §9): nunca
   * escribe `evaluationOutcome`, solo incrementa `consecutiveFailureCount`
   * y libera el lease para un reintento posterior con backoff.
   */
  recordInfrastructureFailure(
    claim: AiEvaluationLeaseClaim,
    reason: string,
    at: Date,
  ): Promise<boolean>

  /** Progreso de la promocion atomica de dos escrituras (#572 §8, §13): auditoria/recuperacion, nunca el mecanismo de seguridad en si (eso vive en `AiModelRegistry`). */
  markPromotionStatus(
    modelVersion: string,
    promotionStatus: AiEvaluationPromotionStatus,
    at: Date,
  ): Promise<void>

  /** Historial de rollbacks que reactivaron este `modelVersion` (#572 §10): auditoria append-only. */
  appendRollbackEvent(
    modelVersion: string,
    event: AiModelRollbackAuditEvent,
    at: Date,
  ): Promise<void>

  getByModelVersion(modelVersion: string): Promise<AiEvaluationLedgerSnapshot | null>
}

export const AI_EVALUATION_COORDINATOR = Symbol('AiEvaluationCoordinatorPort')
