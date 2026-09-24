import {
  RewardInvalidRequestError,
  RewardOperationConflictError,
  RewardRejectedError,
} from '../../../application/errors/RewardIntegrationErrors'
import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import type {
  RewardCreditCommand,
  RewardCreditPort,
  RewardCreditResult,
} from '../../../application/ports/RewardCreditPort'
import { postInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'

const SERVICE = 'wallet'
const PATH = '/api/internal/v1/wallet/credits/battle-reward'

/**
 * Cliente del contrato interno de Wallet (HU-22, `hu-22-reward-contract-v1`
 * §3): `POST /api/internal/v1/wallet/credits/battle-reward`, protegido con
 * `@InternalOnly()` + `InternalServiceGuard` HMAC en Wallet (Combat ya esta en
 * su `INTERNAL_CALLERS`).
 *
 * PARSER ESTRICTO, mismo criterio que `PlayerInventoryHttpClient`: el cuerpo
 * se valida campo a campo; cualquier forma que no cumpla el contrato lanza
 * `UpstreamServiceError('wallet', 'respuesta_invalida')`. Wallet decide el
 * saldo y el progreso; este cliente nunca los recalcula ni completa un campo
 * ausente con un valor por defecto.
 */
export class WalletHttpClient implements RewardCreditPort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async creditBattleReward(command: RewardCreditCommand): Promise<RewardCreditResult> {
    const result = await postInternalJson(
      SERVICE,
      PATH,
      {
        operationId: command.operationId,
        playerId: command.playerId,
        battleId: command.battleId,
        reason: 'BATTLE_REWARD',
        creditsAmount: command.creditsAmount,
        victoryCreditsAmount: command.victoryCreditsAmount,
        occurredAt: command.occurredAt.toISOString(),
      },
      this.options,
    )

    if (result.outcome === 'conflict') {
      throw new RewardOperationConflictError(SERVICE, command.operationId)
    }

    if (result.outcome === 'rejected') {
      throw new RewardRejectedError(SERVICE, describeRejection(result.body), codeOf(result.body))
    }

    if (result.outcome === 'invalid') {
      throw new RewardInvalidRequestError(SERVICE, result.status, result.detail)
    }

    return parseCreditResult(result.body)
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

const nonNegativeInteger = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidResponse()
  }

  return value
}

const parseCreditResult = (body: unknown): RewardCreditResult => {
  const record = asRecord(body)

  return {
    applied: requiredBoolean(record.applied),
    balance: nonNegativeInteger(record.balance),
    victoryProgress: nonNegativeInteger(record.victoryProgress),
    weeklyChestCount: nonNegativeInteger(record.weeklyChestCount),
    weeklyChestLimit: nonNegativeInteger(record.weeklyChestLimit),
    chestEarned: requiredBoolean(record.chestEarned),
  }
}

const describeRejection = (body: unknown): string => {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const message = (body as UnknownRecord).message

    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }

  return 'Wallet rechazo la operacion (422).'
}

const codeOf = (body: unknown): string | null => {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const code = (body as UnknownRecord).code

    return typeof code === 'string' ? code : null
  }

  return null
}
