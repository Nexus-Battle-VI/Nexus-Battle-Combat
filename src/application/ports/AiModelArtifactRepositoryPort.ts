/** Artefacto binario inmutable, content-addressed por su propio SHA-256 (EN-037.1, #570 §30-32). */
export interface AiModelArtifact {
  readonly sha256: string
  readonly sizeBytes: number
  readonly bytes: Buffer
  readonly createdAt: Date
}

/**
 * Puerto del artifact store (EN-037.1, Management #570 §47): separado del
 * registry de metadata/lifecycle (#570 §31) para que el binario inmutable
 * nunca se mezcle con el documento mutable de estado. Application/domain
 * nunca importa `mongodb`/`Binary`.
 */
/** `PARITY_REFERENCE` (EN-037.3, Management #572 §6): `pytorch-parity-reference.json`, nunca interpretado por este puerto, solo persistido content-addressed igual que `ONNX_MODEL`. */
export type AiModelArtifactType = 'ONNX_MODEL' | 'PARITY_REFERENCE' | 'EVALUATION_SUMMARY'

export interface AiModelArtifactRepositoryPort {
  /**
   * Content-addressed (#570 §30, §33): `sha256` DEBE ser el SHA-256 real
   * de `bytes` (el caller ya lo valido contra el manifest antes de
   * llamar aqui). Idempotente: mismo `sha256` + mismos bytes -> no-op.
   * Mismo `sha256` + bytes distintos -> `ArtifactConflictError` (nunca
   * sobreescribe). Si `bytes.length` excede el limite de la estrategia
   * de almacenamiento elegida -> `ModelArtifactTooLargeError`, fail
   * closed ANTES de insertar nada. `artifactType` es solo una etiqueta de
   * auditoria en el documento Mongo (#572 §6) -- este puerto nunca la lee
   * de vuelta ni discrimina comportamiento por ella.
   */
  put(sha256: string, bytes: Buffer, at: Date, artifactType?: AiModelArtifactType): Promise<void>

  /** `null` si no existe ningun artefacto con ese `sha256`. */
  getBySha256(sha256: string): Promise<AiModelArtifact | null>
}

export const AI_MODEL_ARTIFACT_REPOSITORY = Symbol('AiModelArtifactRepositoryPort')
