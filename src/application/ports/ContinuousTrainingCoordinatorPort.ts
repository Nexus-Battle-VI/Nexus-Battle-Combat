/**
 * Puerto de coordinacion del worker de reentrenamiento continuo (EN-037.2,
 * Management #571 §6). Un UNICO documento singleton (`_id='default'`)
 * concentra cursor + lease: cada transicion (reclamar, renovar, liberar,
 * registrar resultado) es UNA sola escritura Mongo atomica, nunca dos
 * escrituras separadas que podrian quedar a medias.
 *
 * No existe ningun lock distribuido reutilizable en Combat hoy
 * (`RoomCommandLockPort`/`ChannelLock` es en memoria, de una sola replica,
 * ADR-020 -- nunca cruza procesos). Este puerto SI vive en Mongo y usa un
 * fencing token monotonico: un propietario cuyo token ya no coincide con el
 * documento NUNCA puede escribir un resultado (#571 §6.2) -- aunque su
 * subproceso de entrenamiento siga corriendo fisicamente (limite declarado,
 * no resuelto por este puerto: ver `docs/en-037-continuous-training-worker.md`).
 */

export type ContinuousTrainingRunOutcome = 'SUCCESS' | 'FAILED' | 'NOT_TRAINABLE'

/** `WIN_RATE_TOO_LOW`/gates NO existen aqui a proposito: son de `#572`, nunca de este worker. */
export type ContinuousTrainingFailureReasonCode =
  | 'DATASET_BUILD_FAILED'
  | 'TRAINING_PROCESS_FAILED'
  | 'ARTIFACT_INVALID'
  | 'REGISTRY_REJECTED'
  | 'LEASE_LOST'
  | 'TRANSIENT_ERROR'

export interface TrainingLeaseClaim {
  readonly ownerId: string
  readonly fencingToken: number
}

export interface ContinuousTrainingCoordinatorSnapshot {
  readonly requestedThrough: Date
  readonly processedThrough: Date
  readonly leaseState: 'IDLE' | 'CLAIMED'
  readonly consecutiveFailureCount: number
  readonly lastRunOutcome: ContinuousTrainingRunOutcome | null
  readonly lastRunAt: Date | null
  readonly lastRunModelVersion: string | null
}

export interface ContinuousTrainingCoordinatorPort {
  /**
   * Avanza `requestedThrough` al maximo entre el valor actual y `candidateThrough`
   * (`$max`, #571 §5.1): idempotente, segura bajo cualquier numero de
   * llamadas concurrentes, nunca retrocede. NO requiere el lease: es pura
   * contabilidad de "hasta donde hay trabajo elegible", nunca una escritura
   * que decida quien entrena.
   */
  advanceRequestedThrough(candidateThrough: Date, at: Date): Promise<void>

  getSnapshot(): Promise<ContinuousTrainingCoordinatorSnapshot>

  /**
   * Reclama el lease de forma atomica (#571 §6.1): solo prospera si esta
   * `IDLE` o si el lease anterior ya expiro. `null` si otro propietario
   * tiene un lease vigente. El `fencingToken` devuelto es el credencial que
   * CADA escritura posterior debe volver a presentar.
   */
  tryClaimLease(
    ownerId: string,
    leaseDurationMs: number,
    at: Date,
  ): Promise<TrainingLeaseClaim | null>

  /** `false` si el lease ya no es mio (expiro y otro lo reclamo): debo abortar el run. */
  renewLease(claim: TrainingLeaseClaim, leaseDurationMs: number, at: Date): Promise<boolean>

  /** Libera el lease. No-op seguro si el lease ya no es mio. */
  releaseLease(claim: TrainingLeaseClaim, at: Date): Promise<void>

  /**
   * Registra el resultado Y libera el lease en UNA sola escritura atomica,
   * condicionada al fencing token (#571 §6.2): `false` si el lease ya no es
   * mio, en cuyo caso el caller NUNCA debe tratar el resultado como
   * confirmado (aunque el entrenamiento en si haya terminado con exito).
   */
  recordSuccess(
    claim: TrainingLeaseClaim,
    processedThrough: Date,
    modelVersion: string,
    at: Date,
  ): Promise<boolean>

  /**
   * `NOT_TRAINABLE` definitivo: avanza `processedThrough` (#571 §7.3) --
   * solo se llama tras agotar `recordNotTrainableRetry` (revision de
   * codigo): un dataset "no entrenable" puede ser una condicion
   * TEMPORAL (labels todavia en vuelo, #571 §4/§7.3-revision) y no
   * definitiva -- avanzar el cursor de inmediato en la PRIMERA deteccion
   * podria dejar datos elegibles sin volver a intentarse nunca si no
   * llega ninguna partida nueva despues.
   */
  recordNotTrainable(
    claim: TrainingLeaseClaim,
    processedThrough: Date,
    reason: string,
    at: Date,
  ): Promise<boolean>

  /**
   * `NOT_TRAINABLE` reintentable (revision de codigo, #571): como
   * `recordFailure` (incrementa `consecutiveFailureCount` para backoff,
   * NUNCA avanza `processedThrough`), pero registra
   * `lastRunOutcome='NOT_TRAINABLE'` en vez de `'FAILED'` -- distingue
   * "los datos insuficientes podrian resolverse solos" de un error
   * tecnico real. El worker decide, segun `consecutiveFailureCount`,
   * cuando dejar de reintentar y llamar `recordNotTrainable` en su lugar
   * (nunca un bucle infinito).
   */
  recordNotTrainableRetry(claim: TrainingLeaseClaim, reason: string, at: Date): Promise<boolean>

  /** `FAILED` NUNCA avanza `processedThrough` (#571 §6.3): el mismo corte se reintenta, con backoff segun `consecutiveFailureCount`. */
  recordFailure(
    claim: TrainingLeaseClaim,
    reasonCode: ContinuousTrainingFailureReasonCode,
    reason: string,
    at: Date,
  ): Promise<boolean>
}

export const CONTINUOUS_TRAINING_COORDINATOR = Symbol('ContinuousTrainingCoordinatorPort')
