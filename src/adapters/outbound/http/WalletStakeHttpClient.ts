import {
  StakeOperationConflictError,
  StakeRejectedError,
} from '../../../application/errors/StakeIntegrationErrors'
import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import type {
  WalletStakeOperationResult,
  WalletStakePort,
  WalletStakeReleaseCommand,
  WalletStakeReserveCommand,
  WalletStakeSettleCommand,
  WalletStakeSettleResult,
  WalletStakeSettlementResult,
} from '../../../application/ports/WalletStakePort'
import { postInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'

const SERVICE = 'wallet'
const RESERVE_PATH = '/api/internal/v1/wallet/stakes/reserve'
const RELEASE_PATH = '/api/internal/v1/wallet/stakes/release'
const SETTLE_PATH = '/api/internal/v1/wallet/stakes/settle'

/**
 * Cliente del contrato interno de apuestas de Wallet (HU-23,
 * `hu-23-battle-stake-v1` §5). Reutiliza `postInternalJson` (misma firma HMAC
 * que HU-22): no reimplementa la firma.
 *
 * PARSER ESTRICTO, mismo criterio que `WalletHttpClient`: el cuerpo se valida
 * campo a campo; cualquier forma que no cumpla el contrato lanza
 * `UpstreamServiceError('wallet', 'respuesta_invalida')`. Wallet decide el
 * saldo; este cliente nunca lo recalcula ni completa un campo ausente.
 */
export class WalletStakeHttpClient implements WalletStakePort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async reserve(command: WalletStakeReserveCommand): Promise<WalletStakeOperationResult> {
    const result = await postInternalJson(
      SERVICE,
      RESERVE_PATH,
      {
        operationId: command.operationId,
        playerId: command.playerId,
        battleId: command.battleId,
        amount: command.amount,
        occurredAt: command.occurredAt.toISOString(),
      },
      this.options,
    )

    const body = WalletStakeHttpClient.expectOk(result, command.operationId)

    return parseOperationResult(body)
  }

  async release(command: WalletStakeReleaseCommand): Promise<WalletStakeOperationResult> {
    const result = await postInternalJson(
      SERVICE,
      RELEASE_PATH,
      {
        operationId: command.operationId,
        holdId: command.holdId,
        reason: command.reason,
      },
      this.options,
    )

    const body = WalletStakeHttpClient.expectOk(result, command.operationId)

    return parseOperationResult(body)
  }

  async settle(command: WalletStakeSettleCommand): Promise<WalletStakeSettleResult> {
    const result = await postInternalJson(
      SERVICE,
      SETTLE_PATH,
      {
        operationId: command.operationId,
        battleId: command.battleId,
        settlements: command.settlements.map((entry) => ({
          playerId: entry.playerId,
          holdId: entry.holdId,
          outcome: entry.outcome,
          amount: entry.amount,
        })),
      },
      this.options,
    )

    const body = WalletStakeHttpClient.expectOk(result, command.operationId)

    return parseSettleResult(body)
  }

  private static expectOk(
    result: Awaited<ReturnType<typeof postInternalJson>>,
    operationId: string,
  ): unknown {
    if (result.outcome === 'conflict') {
      throw new StakeOperationConflictError(SERVICE, operationId)
    }

    if (result.outcome === 'rejected') {
      throw new StakeRejectedError(SERVICE, describeRejection(result.body), codeOf(result.body))
    }

    return result.body
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

const requiredString = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
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

const parseOperationResult = (body: unknown): WalletStakeOperationResult => {
  const record = asRecord(body)

  return {
    operationId: requiredString(record.operationId),
    applied: requiredBoolean(record.applied),
    holdId: requiredString(record.holdId),
    balance: nonNegativeInteger(record.balance),
    reserved: nonNegativeInteger(record.reserved),
    available: nonNegativeInteger(record.available),
  }
}

const parseSettlementResult = (value: unknown): WalletStakeSettlementResult => {
  const record = asRecord(value)

  return {
    playerId: requiredString(record.playerId),
    holdId: requiredString(record.holdId),
    balance: nonNegativeInteger(record.balance),
    reserved: nonNegativeInteger(record.reserved),
    available: nonNegativeInteger(record.available),
  }
}

const parseSettleResult = (body: unknown): WalletStakeSettleResult => {
  const record = asRecord(body)
  const results = record.results

  if (!Array.isArray(results)) {
    throw invalidResponse()
  }

  return {
    operationId: requiredString(record.operationId),
    applied: requiredBoolean(record.applied),
    results: results.map(parseSettlementResult),
  }
}

const describeRejection = (body: unknown): string => {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const message = (body as UnknownRecord).message

    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }

  return 'Wallet rechazo la operacion de apuesta (422).'
}

const codeOf = (body: unknown): string | null => {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const code = (body as UnknownRecord).code

    return typeof code === 'string' ? code : null
  }

  return null
}
