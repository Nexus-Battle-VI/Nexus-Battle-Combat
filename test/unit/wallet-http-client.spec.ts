import 'reflect-metadata'

import { WalletHttpClient } from '../../src/adapters/outbound/http/WalletHttpClient'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import {
  RewardInvalidRequestError,
  RewardOperationConflictError,
  RewardRejectedError,
} from '../../src/application/errors/RewardIntegrationErrors'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { Logger } from '../../src/infrastructure/observability/logger'

const NOW = new Date('2026-09-22T10:00:00.000Z')
const SECRET = 'secreto-compartido-de-pruebas'
const clock: ClockPort = { now: () => NOW }
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  }) as unknown as Response

const baseOptions = {
  baseUrl: 'https://wallet.internal',
  callerService: 'combat',
  secret: SECRET,
  clock,
  logger: silentLogger,
}

const command = {
  operationId: 'battle:room-1:player:sub-1:credit',
  playerId: 'sub-1',
  battleId: 'room-1',
  creditsAmount: 2,
  victoryCreditsAmount: 2,
  occurredAt: new Date('2026-09-22T10:06:00.000Z'),
}

describe('WalletHttpClient (HU-22, hu-22-reward-contract-v1 S3)', () => {
  it('firma la peticion con el mismo esquema HMAC que InternalServiceGuard verifica', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    let capturedBody: string | undefined

    const fetchImpl = ((url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = init?.body as string

      return Promise.resolve(
        jsonResponse(200, {
          applied: true,
          balance: 2,
          victoryProgress: 2,
          weeklyChestCount: 0,
          weeklyChestLimit: 2,
          chestEarned: false,
        }),
      )
    }) as unknown as typeof fetch

    const client = new WalletHttpClient({ ...baseOptions, fetchImpl })
    const result = await client.creditBattleReward(command)

    expect(capturedUrl).toBe('https://wallet.internal/api/internal/v1/wallet/credits/battle-reward')
    expect(result).toEqual({
      applied: true,
      balance: 2,
      victoryProgress: 2,
      weeklyChestCount: 0,
      weeklyChestLimit: 2,
      chestEarned: false,
    })

    const timestamp = capturedHeaders?.[INTERNAL_TIMESTAMP_HEADER]
    const expectedSignature = signInternalRequest(SECRET, {
      service: 'combat',
      method: 'POST',
      path: '/api/internal/v1/wallet/credits/battle-reward',
      timestamp: timestamp ?? '',
      body: JSON.parse(capturedBody ?? '{}') as unknown,
    })

    expect(capturedHeaders?.[INTERNAL_SERVICE_HEADER]).toBe('combat')
    expect(capturedHeaders?.[INTERNAL_SIGNATURE_HEADER]).toBe(expectedSignature)
  })

  it('409 se traduce a RewardOperationConflictError, nunca al cuerpo crudo', async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(409, { code: 'OPERATION_CONFLICT' }))) as unknown as typeof fetch
    const client = new WalletHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.creditBattleReward(command)).rejects.toThrow(RewardOperationConflictError)
  })

  it('422 se traduce a RewardRejectedError con el codigo y mensaje del cuerpo', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse(422, {
          code: 'INVALID_REWARD_AMOUNT',
          message: 'creditsAmount fuera del catalogo',
        }),
      )) as unknown as typeof fetch
    const client = new WalletHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.creditBattleReward(command)).rejects.toMatchObject({
      name: 'RewardRejectedError',
      code: 'INVALID_REWARD_AMOUNT',
    })
  })

  it('un 503 o una red inalcanzable se traducen a UpstreamServiceError, no al error crudo', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    const client = new WalletHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.creditBattleReward(command)).rejects.toThrow(UpstreamServiceError)
  })

  it('un 400 es PERMANENTE: RewardInvalidRequestError (terminal), no un fallo reintentable', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse(400, { message: ['creditsAmount must be a number'], statusCode: 400 }),
      )) as unknown as typeof fetch
    const client = new WalletHttpClient({ ...baseOptions, fetchImpl })

    const error: unknown = await client
      .creditBattleReward(command)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RewardInvalidRequestError)
    expect(error).toBeInstanceOf(RewardRejectedError)
    expect(error).not.toBeInstanceOf(UpstreamServiceError)
    expect((error as Error).message).toContain('creditsAmount must be a number')
  })

  it('una respuesta con forma invalida (falta un campo) responde respuesta_invalida, no inventa el valor', async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(200, { applied: true, balance: 2 }))) as unknown as typeof fetch
    const client = new WalletHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.creditBattleReward(command)).rejects.toMatchObject({
      reason: 'respuesta_invalida',
    })
  })
})
