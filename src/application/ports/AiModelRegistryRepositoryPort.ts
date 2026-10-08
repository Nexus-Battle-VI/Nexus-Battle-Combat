import type { AiModelVersion } from '../../domain/entities/AiModelVersion'

/**
 * Puerto de persistencia del model registry (EN-037.1, Management #570
 * §47): application/domain nunca importa `mongodb`. Operaciones
 * minimas, sin logica de negocio (eso vive en `AiModelRegistry`, #570
 * §48).
 */
export interface AiModelRegistryRepositoryPort {
  /**
   * Inserta una version NUEVA (siempre `TRAINING`, `revision=0`).
   * Idempotente (#570 §52, mismo patron que `CombatDecisionTelemetryRepositoryPort`):
   * mismo `modelVersion` + mismo lineage -> no-op silencioso; mismo
   * `modelVersion` + lineage distinto -> `ModelVersionConflictError`.
   */
  insertNew(version: AiModelVersion): Promise<void>

  /**
   * Reemplaza la version con concurrencia optimista (#570 §40, mismo
   * patron que `BattleRoomRepositoryPort.save`): la escritura solo
   * prospera si la revision almacenada sigue siendo `expectedRevision`.
   * Si no, lanza `ModelVersionConflictError`. Si la transicion es hacia
   * `ACTIVE` y ya existe otra version `ACTIVE`, lanza
   * `ActiveModelConflictError` (indice unico parcial, #570 §41-42).
   */
  replaceWithExpectedRevision(version: AiModelVersion, expectedRevision: number): Promise<void>

  /** `null` si no existe ninguna version con ese `modelVersion`. */
  findByVersion(modelVersion: string): Promise<AiModelVersion | null>

  /**
   * La UNICA version `ACTIVE`, determinista (#570 §45): `null` si ninguna
   * lo es. Dos documentos `ACTIVE` simultaneos son imposibles por el
   * indice unico parcial -- si alguna vez ocurriera, es un estado
   * corrupto, no una ambiguedad a resolver aqui elegiendo "la mas
   * reciente".
   */
  findActive(): Promise<AiModelVersion | null>

  /** `null` si ningun `trainingRunId` registrado coincide. */
  findByTrainingRunId(trainingRunId: string): Promise<AiModelVersion | null>
}

export const AI_MODEL_REGISTRY_REPOSITORY = Symbol('AiModelRegistryRepositoryPort')
