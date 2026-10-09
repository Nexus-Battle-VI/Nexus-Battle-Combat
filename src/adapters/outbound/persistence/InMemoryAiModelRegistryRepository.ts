import type { AiModelVersion } from '../../../domain/entities/AiModelVersion'
import { AiModelState } from '../../../domain/value-objects/AiModelState'
import {
  ActiveModelConflictError,
  ModelVersionConflictError,
} from '../../../domain/errors/AiModelRegistryErrors'
import type {
  ActiveModelReference,
  AiModelRegistryRepositoryPort,
} from '../../../application/ports/AiModelRegistryRepositoryPort'
import { sameTrainingLineage } from './ai-model-registry-mapping'

/** Respaldo en memoria (`PERSISTENCE_DRIVER=memory`), mismo contrato que `MongoAiModelRegistryRepository`. */
export class InMemoryAiModelRegistryRepository implements AiModelRegistryRepositoryPort {
  private readonly versions = new Map<string, { version: AiModelVersion; revision: number }>()
  private activeReference: ActiveModelReference | null = null

  insertNew(version: AiModelVersion): Promise<void> {
    const existing = this.versions.get(version.modelVersion)

    if (existing !== undefined) {
      if (!sameTrainingLineage(existing.version.trainingLineage, version.trainingLineage)) {
        return Promise.reject(
          new ModelVersionConflictError(
            `ya existe una version "${version.modelVersion}" con lineage de training distinto.`,
          ),
        )
      }
      return Promise.resolve()
    }

    this.versions.set(version.modelVersion, { version, revision: version.revision })
    return Promise.resolve()
  }

  replaceWithExpectedRevision(version: AiModelVersion, expectedRevision: number): Promise<void> {
    const existing = this.versions.get(version.modelVersion)

    if (existing?.revision !== expectedRevision) {
      return Promise.reject(
        new ModelVersionConflictError(
          `la version "${version.modelVersion}" ya no esta en revision ${String(expectedRevision)}.`,
        ),
      )
    }

    if (version.state === AiModelState.Active) {
      for (const [modelVersion, entry] of this.versions) {
        if (modelVersion !== version.modelVersion && entry.version.state === AiModelState.Active) {
          return Promise.reject(new ActiveModelConflictError())
        }
      }
    }

    this.versions.set(version.modelVersion, { version, revision: version.revision })
    return Promise.resolve()
  }

  findByVersion(modelVersion: string): Promise<AiModelVersion | null> {
    return Promise.resolve(this.versions.get(modelVersion)?.version ?? null)
  }

  findActive(): Promise<AiModelVersion | null> {
    return Promise.resolve(
      this.activeReference === null
        ? null
        : (this.versions.get(this.activeReference.modelVersion)?.version ?? null),
    )
  }

  getActiveReference(): Promise<ActiveModelReference | null> {
    return Promise.resolve(this.activeReference)
  }

  compareAndSwapActiveReference(
    expected: ActiveModelReference | null,
    next: { readonly modelVersion: string; readonly modelRevision: number },
  ): Promise<ActiveModelReference | null> {
    const current = this.activeReference
    const matches =
      expected === null
        ? current === null
        : current !== null &&
          current.modelVersion === expected.modelVersion &&
          current.modelRevision === expected.modelRevision &&
          current.generation === expected.generation
    if (!matches) return Promise.resolve(null)
    this.activeReference = {
      ...next,
      generation: (current?.generation ?? 0) + 1,
    }
    return Promise.resolve(this.activeReference)
  }

  findByTrainingRunId(trainingRunId: string): Promise<AiModelVersion | null> {
    for (const entry of this.versions.values()) {
      if (entry.version.trainingLineage.trainingRunId === trainingRunId) {
        return Promise.resolve(entry.version)
      }
    }
    return Promise.resolve(null)
  }

  listByState(state: AiModelState): Promise<readonly AiModelVersion[]> {
    const matches = [...this.versions.values()]
      .filter((entry) => entry.version.state === state)
      .sort((left, right) => left.version.createdAt.getTime() - right.version.createdAt.getTime())
      .map((entry) => entry.version)
    return Promise.resolve(matches)
  }
}
