import {
  ArtifactConflictError,
  ModelArtifactTooLargeError,
} from '../../../domain/errors/AiModelRegistryErrors'
import type {
  AiModelArtifact,
  AiModelArtifactRepositoryPort,
} from '../../../application/ports/AiModelArtifactRepositoryPort'
import { MAX_ARTIFACT_BYTES } from './MongoAiModelArtifactRepository'

/** Respaldo en memoria (`PERSISTENCE_DRIVER=memory`), mismo contrato que `MongoAiModelArtifactRepository`. */
export class InMemoryAiModelArtifactRepository implements AiModelArtifactRepositoryPort {
  private readonly artifacts = new Map<string, AiModelArtifact>()

  put(sha256: string, bytes: Buffer, at: Date): Promise<void> {
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      return Promise.reject(new ModelArtifactTooLargeError(bytes.length, MAX_ARTIFACT_BYTES))
    }

    const existing = this.artifacts.get(sha256)

    if (existing !== undefined) {
      if (Buffer.compare(existing.bytes, bytes) !== 0) {
        return Promise.reject(new ArtifactConflictError(sha256))
      }
      return Promise.resolve()
    }

    this.artifacts.set(sha256, { sha256, sizeBytes: bytes.length, bytes, createdAt: at })
    return Promise.resolve()
  }

  getBySha256(sha256: string): Promise<AiModelArtifact | null> {
    return Promise.resolve(this.artifacts.get(sha256) ?? null)
  }
}
