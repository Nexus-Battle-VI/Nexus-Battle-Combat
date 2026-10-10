import type { AiEvaluationCoordinatorPort } from '../../src/application/ports/AiEvaluationCoordinatorPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { RollbackActiveModel } from '../../src/application/services/RollbackActiveModel'
import type { AiModelVersion } from '../../src/domain/entities/AiModelVersion'

const AT = new Date('2027-01-01T00:00:00.000Z')
const active = (modelVersion: string): AiModelVersion =>
  ({ modelVersion }) as unknown as AiModelVersion

describe('RollbackActiveModel (EN-037.3, Management #572 §10)', () => {
  it('reactiva la version SUPERSEDED y deja evidencia auditable con operationId', async () => {
    const registry = {
      findActive: jest.fn().mockResolvedValue(active('model-v2')),
      rollbackToSuperseded: jest.fn().mockResolvedValue(active('model-v1')),
    }
    const ledger = {
      appendRollbackEvent: jest.fn().mockResolvedValue(undefined),
      getByModelVersion: jest.fn().mockResolvedValue({
        evaluationOutcome: 'PASS',
        promotionStatus: 'COMPLETED',
      }),
    } as unknown as AiEvaluationCoordinatorPort
    const logger = { info: jest.fn() }
    const service = new RollbackActiveModel(
      registry,
      ledger,
      { now: () => AT } satisfies ClockPort,
      logger,
    )

    await service.execute({
      operationId: 'rollback-incident-42',
      targetVersion: 'model-v1',
      reason: 'fallo operacional confirmado',
    })

    // eslint-disable-next-line @typescript-eslint/unbound-method -- propiedad jest.fn, no metodo real.
    expect(registry.rollbackToSuperseded).toHaveBeenCalledWith('model-v1')
    // eslint-disable-next-line @typescript-eslint/unbound-method -- puerto reemplazado por jest.fn.
    expect(ledger.appendRollbackEvent).toHaveBeenCalledWith(
      'model-v1',
      {
        rollbackId: 'rollback-incident-42',
        fromVersion: 'model-v2',
        reason: 'fallo operacional confirmado',
      },
      AT,
    )
    expect(logger.info).toHaveBeenCalledWith('ai_model_rollback_completed', {
      operationId: 'rollback-incident-42',
      previousActiveVersion: 'model-v2',
      nextActiveVersion: 'model-v1',
      idempotent: false,
    })
  })

  it('un reintento cuyo destino ya es ACTIVE es no-op', async () => {
    const registry = {
      findActive: jest.fn().mockResolvedValue(active('model-v1')),
      rollbackToSuperseded: jest.fn(),
    }
    const ledger = {
      appendRollbackEvent: jest.fn(),
      getByModelVersion: jest.fn(),
    } as unknown as AiEvaluationCoordinatorPort
    const service = new RollbackActiveModel(
      registry,
      ledger,
      { now: () => AT },
      { info: jest.fn() },
    )

    await service.execute({
      operationId: 'rollback-incident-42',
      targetVersion: 'model-v1',
      reason: 'retry',
    })

    // eslint-disable-next-line @typescript-eslint/unbound-method -- propiedad jest.fn, no metodo real.
    expect(registry.rollbackToSuperseded).not.toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- puerto reemplazado por jest.fn.
    expect(ledger.appendRollbackEvent).not.toHaveBeenCalled()
  })

  it('rechaza rollback sin ACTIVE o sin motivo auditable', async () => {
    const registry = {
      findActive: jest.fn().mockResolvedValue(null),
      rollbackToSuperseded: jest.fn(),
    }
    const service = new RollbackActiveModel(
      registry,
      {
        appendRollbackEvent: jest.fn(),
        getByModelVersion: jest.fn(),
      } as unknown as AiEvaluationCoordinatorPort,
      { now: () => AT },
      { info: jest.fn() },
    )

    await expect(
      service.execute({ operationId: 'rollback-1', targetVersion: 'model-v1', reason: '' }),
    ).rejects.toThrow('reason')
    await expect(
      service.execute({
        operationId: 'rollback-1',
        targetVersion: 'model-v1',
        reason: 'incidente',
      }),
    ).rejects.toThrow('No existe un modelo ACTIVE')
  })

  it('rechaza una version sin evidencia PASS antes de tocar la autoridad ACTIVE', async () => {
    const registry = {
      findActive: jest.fn().mockResolvedValue(active('model-v2')),
      rollbackToSuperseded: jest.fn(),
    }
    const ledger = {
      getByModelVersion: jest.fn().mockResolvedValue({
        evaluationOutcome: 'FAIL',
        promotionStatus: 'NOT_APPLICABLE',
      }),
      appendRollbackEvent: jest.fn(),
    } as unknown as AiEvaluationCoordinatorPort
    const service = new RollbackActiveModel(
      registry,
      ledger,
      { now: () => AT },
      { info: jest.fn() },
    )

    await expect(
      service.execute({
        operationId: 'rollback-invalid',
        targetVersion: 'model-v1',
        reason: 'incidente',
      }),
    ).rejects.toThrow('evidencia PASS')
    expect(registry.rollbackToSuperseded).not.toHaveBeenCalled()
  })
})
