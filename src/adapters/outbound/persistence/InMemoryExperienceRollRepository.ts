import type {
  ExperienceRollBatchIntent,
  ExperienceRollBatchSnapshot,
  ExperienceRollInsertResult,
  ExperienceRollRepositoryPort,
} from '../../../application/ports/ExperienceRollRepositoryPort'

/**
 * Doble de pruebas y de desarrollo del lote de tiradas (HU-09, Task HU-09.2).
 *
 * Misma semantica que `MongoExperienceRollRepository`, y en particular la misma
 * que importa: `insertIfAbsent` NO sobrescribe un lote existente y lo dice con
 * `created: false`, para que el caso de uso pueda responder con lo guardado en
 * lugar de con tiradas nuevas.
 *
 * Guarda instantaneas, no objetos vivos: lo que se lee es lo que se escribio.
 */
export class InMemoryExperienceRollRepository implements ExperienceRollRepositoryPort {
  private readonly batches = new Map<string, ExperienceRollBatchSnapshot>()

  findById(operationId: string): Promise<ExperienceRollBatchSnapshot | null> {
    return Promise.resolve(this.batches.get(operationId) ?? null)
  }

  insertIfAbsent(intent: ExperienceRollBatchIntent): Promise<ExperienceRollInsertResult> {
    const existing = this.batches.get(intent.operationId)

    if (existing !== undefined) {
      return Promise.resolve({ batch: existing, created: false })
    }

    // Un unico instante para el lote y sus tiradas: se persistieron juntas.
    const now = new Date()
    const batch: ExperienceRollBatchSnapshot = Object.freeze({
      operationId: intent.operationId,
      enrollmentId: intent.enrollmentId,
      simulationId: intent.simulationId,
      heroId: intent.heroId,
      defeats: intent.defeats.map((defeat) => Object.freeze({ ...defeat, persistedAt: now })),
      createdAt: now,
    })

    this.batches.set(intent.operationId, batch)

    return Promise.resolve({ batch, created: true })
  }
}
