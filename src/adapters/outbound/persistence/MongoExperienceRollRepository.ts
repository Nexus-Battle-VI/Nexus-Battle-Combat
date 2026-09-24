import type { Collection, Db } from 'mongodb'

import type {
  ExperienceRollBatchIntent,
  ExperienceRollBatchSnapshot,
  ExperienceRollInsertResult,
  ExperienceRollRepositoryPort,
} from '../../../application/ports/ExperienceRollRepositoryPort'
import { toDocument, toSnapshot, type ExperienceRollBatchDocument } from './experience-roll-mapping'

export const EXPERIENCE_ROLLS_COLLECTION = 'experience-rolls'

/**
 * Persistencia del lote de tiradas de experiencia sobre MongoDB (HU-09, Task
 * HU-09.2; `hu-09-experience-reward-v1` §5).
 *
 * UN DOCUMENTO POR LOTE, con `_id` = `operationId`
 * (`mission:{enrollmentId}:xp-rolls`, lo calcula Missions). No es una eleccion
 * estetica:
 *   - la escritura del lote entero es UNA sola operacion, asi que no puede
 *     quedar un lote a medias con unas tiradas si y otras no;
 *   - el documento es lo unico que permite DETECTAR el `409` del contrato
 *     comparando el contenido cuando llega el mismo `operationId` con otra lista
 *     de derrotas.
 *
 * `updateOne` con `$setOnInsert` y `upsert`: es el MISMO idioma de
 * `MongoRewardWorkflowRepository.createIfAbsent`. La unicidad de `_id` es la
 * unica defensa y es suficiente -- no hay transaccion ni bloqueo, y el que
 * pierde la carrera NO sobrescribe: relee y devuelve `created: false` con lo que
 * quedo guardado, que es lo que exige la idempotencia del contrato.
 *
 * SIN INDICE SECUNDARIO: todas las consultas van por `_id`.
 */
export class MongoExperienceRollRepository implements ExperienceRollRepositoryPort {
  private readonly batches: Collection<ExperienceRollBatchDocument>

  constructor(db: Db) {
    this.batches = db.collection<ExperienceRollBatchDocument>(EXPERIENCE_ROLLS_COLLECTION)
  }

  async findById(operationId: string): Promise<ExperienceRollBatchSnapshot | null> {
    const document = await this.batches.findOne({ _id: operationId })

    return document === null ? null : toSnapshot(document)
  }

  async insertIfAbsent(intent: ExperienceRollBatchIntent): Promise<ExperienceRollInsertResult> {
    // Un unico instante para el lote y todas sus tiradas: se persistieron juntas.
    const persistedAt = new Date()

    const document = toDocument({
      operationId: intent.operationId,
      enrollmentId: intent.enrollmentId,
      simulationId: intent.simulationId,
      heroId: intent.heroId,
      defeats: intent.defeats.map((defeat) => ({ ...defeat, persistedAt })),
      createdAt: persistedAt,
    })

    const result = await this.batches.updateOne(
      { _id: document._id },
      { $setOnInsert: document },
      { upsert: true },
    )

    const stored = await this.batches.findOne({ _id: document._id })

    if (stored === null) {
      throw new Error(
        `El lote de tiradas "${intent.operationId}" no existe tras una operacion que debia crearlo.`,
      )
    }

    // `upsertedCount` es la respuesta del motor, no una deduccion: `1` cuando
    // esta llamada inserto, `0` cuando el `_id` ya estaba. Comparar fechas
    // fallaria si dos intentos cayeran en el mismo milisegundo y diria que si
    // se creo un lote que en realidad gano otro.
    return { batch: toSnapshot(stored), created: result.upsertedCount === 1 }
  }
}
