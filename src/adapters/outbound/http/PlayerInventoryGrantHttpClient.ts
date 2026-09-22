import {
  RewardOperationConflictError,
  RewardRejectedError,
} from '../../../application/errors/RewardIntegrationErrors'
import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import type {
  RewardGrantCommand,
  RewardGrantPort,
  RewardGrantResult,
} from '../../../application/ports/RewardGrantPort'
import { postInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'

const SERVICE = 'player-inventory'
const PATH = '/api/internal/v1/inventory/grants'

/**
 * Cliente del contrato interno de Player-Inventory (HU-22,
 * `hu-22-reward-contract-v1` §7): `POST /api/internal/v1/inventory/grants`.
 *
 * NO ES UN CONTRATO NUEVO: es exactamente el de HU-59/HU-69
 * (`docs/purchase-grants.md`), con un lote de un unico `{productId, quantity: 1}`.
 * `combat` ya esta en el `INTERNAL_CALLERS` de Player-Inventory desde HU-15
 * (auditado, `Nexus-Battle-Player-Inventory` PR#40): no hace falta ningun
 * cambio de contrato para que esta llamada se autorice.
 */
export class PlayerInventoryGrantHttpClient implements RewardGrantPort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async grant(command: RewardGrantCommand): Promise<RewardGrantResult> {
    const result = await postInternalJson(
      SERVICE,
      PATH,
      {
        operationId: command.operationId,
        playerId: command.playerId,
        items: [{ productId: command.productId, quantity: command.quantity }],
      },
      this.options,
    )

    if (result.outcome === 'conflict') {
      throw new RewardOperationConflictError(SERVICE, command.operationId)
    }

    if (result.outcome === 'rejected') {
      throw new RewardRejectedError(SERVICE, describeRejection(result.body), codeOf(result.body))
    }

    return parseGrantResult(result.body)
  }
}

const invalidResponse = (): UpstreamServiceError =>
  new UpstreamServiceError(SERVICE, 'respuesta_invalida')

type UnknownRecord = Readonly<Record<string, unknown>>

const asRecord = (value: unknown): UnknownRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidResponse()
  }

  return value as UnknownRecord
}

const requiredBoolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') {
    throw invalidResponse()
  }

  return value
}

const parseGrantResult = (body: unknown): RewardGrantResult => {
  const record = asRecord(body)

  return { applied: requiredBoolean(record.applied) }
}

const describeRejection = (body: unknown): string => {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const message = (body as UnknownRecord).message

    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }

  return 'Player-Inventory rechazo la entrega (422).'
}

const codeOf = (body: unknown): string | null => {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const code = (body as UnknownRecord).code

    return typeof code === 'string' ? code : null
  }

  return null
}
