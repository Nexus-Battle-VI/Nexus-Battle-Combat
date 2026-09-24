import type { ExperienceRoll } from '../../domain/reward/ExperienceRollPolicy'

/**
 * Persistencia del lote de tiradas de experiencia (HU-09, Task HU-09.2).
 *
 * UN DOCUMENTO POR LOTE, no uno por tirada. Dos motivos, y ninguno es estetico:
 * una sola escritura impide que queden conjuntos de tiradas a medias, y el
 * documento es lo unico que permite COMPARAR el contenido cuando llega el mismo
 * `operationId` con otra lista de derrotas -- sin el, el `409` que promete el
 * contrato seria inimplementable.
 *
 * La clave es el `operationId` del lote, `mission:{enrollmentId}:xp-rolls`, que
 * calcula Missions. Dentro van las tiradas, cada una con la clave de su derrota
 * (encuentro + instancia), que es la que identifica la recompensa.
 */

/** Una tirada ya persistida, con el momento en que se guardo. */
export interface ExperienceRollRecord extends ExperienceRoll {
  readonly persistedAt: Date
}

/** Lo que se pide guardar. Las tiradas ya vienen resueltas por la politica. */
export interface ExperienceRollBatchIntent {
  readonly operationId: string
  readonly enrollmentId: string
  readonly simulationId: string
  readonly heroId: string
  readonly defeats: readonly ExperienceRoll[]
}

/** Lo que hay guardado. */
export interface ExperienceRollBatchSnapshot {
  readonly operationId: string
  readonly enrollmentId: string
  readonly simulationId: string
  readonly heroId: string
  readonly defeats: readonly ExperienceRollRecord[]
  readonly createdAt: Date
}

export interface ExperienceRollInsertResult {
  readonly batch: ExperienceRollBatchSnapshot
  /**
   * `false` cuando otro proceso habia guardado ya ese `operationId`. NO es un
   * error: es la carrera entre dos intentos del mismo lote, y el llamante
   * devuelve lo guardado.
   */
  readonly created: boolean
}

export interface ExperienceRollRepositoryPort {
  /** El lote guardado, o `null` si no existe. Es la puerta de la idempotencia. */
  findById(operationId: string): Promise<ExperienceRollBatchSnapshot | null>

  /**
   * Guarda el lote si no existe. Si ya existe -- otra llamada gano la carrera --
   * devuelve el guardado con `created: false`, sin sobrescribirlo.
   */
  insertIfAbsent(intent: ExperienceRollBatchIntent): Promise<ExperienceRollInsertResult>
}

export const EXPERIENCE_ROLL_REPOSITORY = Symbol('ExperienceRollRepositoryPort')
