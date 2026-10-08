import { Binary, MongoServerError, type Collection, type Db } from 'mongodb'

import {
  ArtifactConflictError,
  ModelArtifactTooLargeError,
} from '../../../domain/errors/AiModelRegistryErrors'
import type {
  AiModelArtifact,
  AiModelArtifactRepositoryPort,
} from '../../../application/ports/AiModelArtifactRepositoryPort'

export const AI_MODEL_ARTIFACTS_COLLECTION = 'ai-model-artifacts'

const ARTIFACT_SCHEMA_VERSION = 1

/**
 * El limite REAL de documento de MongoDB (#570 §28-30): 16 MiB, con un
 * margen tecnico documentado (no "8MB porque si") para dejar espacio al
 * resto del documento (`_id`, metadata) y a arquitecturas futuras algo
 * mas grandes que el `model.onnx` de ~37KB medido hoy (#570 §26-27, ver
 * `docs/en-037-model-registry.md`).
 */
const BSON_DOCUMENT_LIMIT_BYTES = 16 * 1024 * 1024
const ARTIFACT_MARGIN_BYTES = 1 * 1024 * 1024
export const MAX_ARTIFACT_BYTES = BSON_DOCUMENT_LIMIT_BYTES - ARTIFACT_MARGIN_BYTES

interface AiModelArtifactDocument {
  readonly _id: string
  readonly schemaVersion: number
  readonly artifactType: 'ONNX_MODEL'
  readonly sizeBytes: number
  readonly bytes: Binary
  readonly createdAt: Date
}

/**
 * Artifact store content-addressed sobre MongoDB (EN-037.1, Management
 * #570 §30-34): `_id = sha256`, BSON `Binary` en vez de GridFS (medicion
 * y justificacion completas en `docs/en-037-model-registry.md`).
 * Idempotente: mismo hash + mismos bytes -> no-op; mismo hash + bytes
 * distintos -> `ArtifactConflictError`, nunca sobreescribe.
 */
export class MongoAiModelArtifactRepository implements AiModelArtifactRepositoryPort {
  private readonly artifacts: Collection<AiModelArtifactDocument>

  constructor(db: Db) {
    this.artifacts = db.collection<AiModelArtifactDocument>(AI_MODEL_ARTIFACTS_COLLECTION)
  }

  async put(sha256: string, bytes: Buffer, at: Date): Promise<void> {
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      throw new ModelArtifactTooLargeError(bytes.length, MAX_ARTIFACT_BYTES)
    }

    try {
      await this.artifacts.insertOne({
        _id: sha256,
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        artifactType: 'ONNX_MODEL',
        sizeBytes: bytes.length,
        bytes: new Binary(bytes),
        createdAt: at,
      })
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error

      const stored = await this.artifacts.findOne({ _id: sha256 })

      if (stored === null || Buffer.compare(stored.bytes.buffer, bytes) !== 0) {
        throw new ArtifactConflictError(sha256)
      }
    }
  }

  async getBySha256(sha256: string): Promise<AiModelArtifact | null> {
    const document = await this.artifacts.findOne({ _id: sha256 })

    if (document === null) return null

    return {
      sha256: document._id,
      sizeBytes: document.sizeBytes,
      bytes: Buffer.from(document.bytes.buffer),
      createdAt: document.createdAt,
    }
  }
}
