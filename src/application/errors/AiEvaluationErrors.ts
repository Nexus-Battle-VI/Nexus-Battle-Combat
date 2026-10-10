export class AiEvaluationLineageConflictError extends Error {
  constructor(modelVersion: string) {
    super(
      `El ledger de evaluacion de "${modelVersion}" ya existe con un lineage de artefactos distinto.`,
    )
    this.name = 'AiEvaluationLineageConflictError'
  }
}
