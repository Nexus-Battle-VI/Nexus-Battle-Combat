import type { AiEvaluationCoordinatorPort } from '../ports/AiEvaluationCoordinatorPort'
import type { ClockPort } from '../ports/ClockPort'
import type { AiModelRegistry } from './AiModelRegistry'

export interface RollbackActiveModelLogger {
  info(message: string, context?: Readonly<Record<string, string | boolean>>): void
}

export interface RollbackActiveModelCommand {
  readonly operationId: string
  readonly targetVersion: string
  readonly reason: string
}

const requireText = (value: string, name: string, maxLength: number): string => {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`${name} debe tener entre 1 y ${String(maxLength)} caracteres.`)
  }
  return normalized
}

/**
 * Operacion interna y auditable de rollback (EN-037.3, Management #572 §10).
 * El registry conserva las invariantes/CAS/hash; este servicio aporta identidad
 * idempotente, motivo y evidencia append-only. No se expone por HTTP.
 */
export class RollbackActiveModel {
  constructor(
    private readonly registry: Pick<AiModelRegistry, 'findActive' | 'rollbackToSuperseded'>,
    private readonly ledger: AiEvaluationCoordinatorPort,
    private readonly clock: ClockPort,
    private readonly logger: RollbackActiveModelLogger,
  ) {}

  async execute(command: RollbackActiveModelCommand): Promise<void> {
    const operationId = requireText(command.operationId, 'operationId', 200)
    const targetVersion = requireText(command.targetVersion, 'targetVersion', 200)
    const reason = requireText(command.reason, 'reason', 1_000)
    const activeBefore = await this.registry.findActive()

    if (activeBefore?.modelVersion === targetVersion) {
      this.logger.info('ai_model_rollback_completed', {
        operationId,
        previousActiveVersion: targetVersion,
        nextActiveVersion: targetVersion,
        idempotent: true,
      })
      return
    }

    if (activeBefore === null) {
      throw new Error('No existe un modelo ACTIVE desde el cual ejecutar rollback.')
    }

    const targetEvidence = await this.ledger.getByModelVersion(targetVersion)
    if (
      targetEvidence?.evaluationOutcome !== 'PASS' ||
      targetEvidence.promotionStatus !== 'COMPLETED'
    ) {
      throw new Error(
        `La version "${targetVersion}" no tiene evidencia PASS/promocion COMPLETED auditable.`,
      )
    }

    const activated = await this.registry.rollbackToSuperseded(targetVersion)
    const at = this.clock.now()
    await this.ledger.appendRollbackEvent(
      activated.modelVersion,
      { rollbackId: operationId, fromVersion: activeBefore.modelVersion, reason },
      at,
    )
    this.logger.info('ai_model_rollback_completed', {
      operationId,
      previousActiveVersion: activeBefore.modelVersion,
      nextActiveVersion: activated.modelVersion,
      idempotent: false,
    })
  }
}
