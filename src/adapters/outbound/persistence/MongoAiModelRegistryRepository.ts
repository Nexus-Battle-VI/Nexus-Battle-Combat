import { Int32, MongoServerError, type Collection, type Db } from 'mongodb'

import type { AiModelVersion } from '../../../domain/entities/AiModelVersion'
import type { AiModelState as AiModelStateType } from '../../../domain/value-objects/AiModelState'
import {
  ActiveModelConflictError,
  ModelVersionConflictError,
} from '../../../domain/errors/AiModelRegistryErrors'
import type {
  ActiveModelReference,
  AiModelRegistryRepositoryPort,
} from '../../../application/ports/AiModelRegistryRepositoryPort'
import {
  sameTrainingLineage,
  toAiModelVersion,
  toDocument,
  type AiModelVersionDocument,
} from './ai-model-registry-mapping'

export const AI_MODEL_VERSIONS_COLLECTION = 'ai-model-versions'
export const AI_MODEL_ACTIVE_REFERENCE_COLLECTION = 'ai-model-active-reference'

interface ActiveModelReferenceDocument {
  readonly _id: 'active'
  readonly modelVersion: string
  readonly modelRevision: Int32
  readonly generation: Int32
  readonly updatedAt: Date
}

/**
 * Repositorio del model registry sobre MongoDB (EN-037.1, Management
 * #570 §47, §61). Nunca contiene logica de negocio (eso vive en
 * `AiModelRegistry`, #570 §48): solo persiste lo que el servicio ya
 * valido, y traduce detalles de Mongo (`E11000`) a errores de dominio.
 */
export class MongoAiModelRegistryRepository implements AiModelRegistryRepositoryPort {
  private readonly versions: Collection<AiModelVersionDocument>
  private readonly activeReferences: Collection<ActiveModelReferenceDocument>

  constructor(db: Db) {
    this.versions = db.collection<AiModelVersionDocument>(AI_MODEL_VERSIONS_COLLECTION)
    this.activeReferences = db.collection<ActiveModelReferenceDocument>(
      AI_MODEL_ACTIVE_REFERENCE_COLLECTION,
    )
  }

  async insertNew(version: AiModelVersion): Promise<void> {
    try {
      await this.versions.insertOne(toDocument(version))
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error

      const stored = await this.versions.findOne({ _id: version.modelVersion })

      if (
        stored === null ||
        !sameTrainingLineage(stored.trainingLineage, version.trainingLineage)
      ) {
        throw new ModelVersionConflictError(
          `ya existe una version "${version.modelVersion}" con lineage de training distinto.`,
        )
      }
    }
  }

  async replaceWithExpectedRevision(
    version: AiModelVersion,
    expectedRevision: number,
  ): Promise<void> {
    const next = toDocument(version)

    try {
      const result = await this.versions.replaceOne(
        { _id: next._id, revision: new Int32(expectedRevision) },
        next,
      )

      if (result.matchedCount === 0) {
        throw new ModelVersionConflictError(
          `la version "${version.modelVersion}" ya no esta en revision ${String(expectedRevision)}.`,
        )
      }
    } catch (error: unknown) {
      // El indice unico parcial sobre `state=ACTIVE` (migracion 027) es la
      // defensa REAL contra dos activaciones concurrentes (#570 §41-42):
      // nunca confiar solo en `findActive()` + `if null, activate()` a
      // nivel de aplicacion.
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new ActiveModelConflictError()
      }
      throw error
    }
  }

  async findByVersion(modelVersion: string): Promise<AiModelVersion | null> {
    const document = await this.versions.findOne({ _id: modelVersion })

    return document === null ? null : toAiModelVersion(document)
  }

  async findActive(): Promise<AiModelVersion | null> {
    const reference = await this.getActiveReference()
    if (reference === null) return null
    const document = await this.versions.findOne({ _id: reference.modelVersion })

    return document === null ? null : toAiModelVersion(document)
  }

  async getActiveReference(): Promise<ActiveModelReference | null> {
    const document = await this.activeReferences.findOne({ _id: 'active' })
    return document === null
      ? null
      : {
          modelVersion: document.modelVersion,
          modelRevision: document.modelRevision.valueOf(),
          generation: document.generation.valueOf(),
        }
  }

  async compareAndSwapActiveReference(
    expected: ActiveModelReference | null,
    next: { readonly modelVersion: string; readonly modelRevision: number },
    at: Date,
  ): Promise<ActiveModelReference | null> {
    if (expected === null) {
      try {
        await this.activeReferences.insertOne({
          _id: 'active',
          modelVersion: next.modelVersion,
          modelRevision: new Int32(next.modelRevision),
          generation: new Int32(1),
          updatedAt: at,
        })
        return { ...next, generation: 1 }
      } catch (error: unknown) {
        if (error instanceof MongoServerError && error.code === 11000) return null
        throw error
      }
    }

    const result = await this.activeReferences.findOneAndUpdate(
      {
        _id: 'active',
        modelVersion: expected.modelVersion,
        modelRevision: new Int32(expected.modelRevision),
        generation: new Int32(expected.generation),
      },
      {
        $set: {
          modelVersion: next.modelVersion,
          modelRevision: new Int32(next.modelRevision),
          updatedAt: at,
        },
        $inc: { generation: new Int32(1) },
      },
      { returnDocument: 'after' },
    )
    return result === null
      ? null
      : {
          modelVersion: result.modelVersion,
          modelRevision: result.modelRevision.valueOf(),
          generation: result.generation.valueOf(),
        }
  }

  async findByTrainingRunId(trainingRunId: string): Promise<AiModelVersion | null> {
    const document = await this.versions.findOne({ 'trainingLineage.trainingRunId': trainingRunId })

    return document === null ? null : toAiModelVersion(document)
  }

  async listByState(state: AiModelStateType): Promise<readonly AiModelVersion[]> {
    const documents = await this.versions.find({ state }).sort({ createdAt: 1 }).toArray()

    return documents.map(toAiModelVersion)
  }
}
