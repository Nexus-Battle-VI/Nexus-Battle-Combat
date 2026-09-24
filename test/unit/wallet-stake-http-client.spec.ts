import 'reflect-metadata'

import { WalletStakeHttpClient } from '../../src/adapters/outbound/http/WalletStakeHttpClient'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import {
  StakeOperationConflictError,
  StakeRejectedError,
} from '../../src/application/errors/StakeIntegrationErrors'
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

const operationResult = {
  operationId: 'battle:room-1:player:sub-1:stake:reserve',
  applied: true,
  holdId: 'battle:room-1:player:sub-1:stake:reserve',
  balance: 100,
  reserved: 10,
  available: 90,
}

const reserveCommand = {
  operationId: 'battle:room-1:player:sub-1:stake:reserve',
  playerId: 'sub-1',
  battleId: 'room-1',
  amount: 10,
  occurredAt: NOW,
}

describe('WalletStakeHttpClient (HU-23, hu-23-battle-stake-v1 §5)', () => {
  it('reserve firma la peticion con el mismo esquema HMAC y parsea la respuesta', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    let capturedBody: string | undefined

    const fetchImpl = ((url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = init?.body as string

      return Promise.resolve(jsonResponse(200, operationResult))
    }) as unknown as typeof fetch

    const client = new WalletStakeHttpClient({ ...baseOptions, fetchImpl })
    const result = await client.reserve(reserveCommand)

    expect(capturedUrl).toBe('https://wallet.internal/api/internal/v1/wallet/stakes/reserve')
    expect(result).toEqual(operationResult)

    const timestamp = capturedHeaders?.[INTERNAL_TIMESTAMP_HEADER]
    const expectedSignature = signInternalRequest(SECRET, {
      service: 'combat',
      method: 'POST',
      path: '/api/internal/v1/wallet/stakes/reserve',
      timestamp: timestamp ?? '',
      body: JSON.parse(capturedBody ?? '{}') as unknown,
    })

    expect(capturedHeaders?.[INTERNAL_SERVICE_HEADER]).toBe('combat')
    expect(capturedHeaders?.[INTERNAL_SIGNATURE_HEADER]).toBe(expectedSignature)
    expect(JSON.parse(capturedBody ?? '{}')).toEqual({
      operationId: reserveCommand.operationId,
      playerId: 'sub-1',
      battleId: 'room-1',
      amount: 10,
      occurredAt: '2026-09-22T10:00:00.000Z',
    })
  })

  it('release envia el holdId y el reason del contrato §5.2', async () => {
    let capturedBody: string | undefined
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      capturedBody = init?.body as string

      return Promise.resolve(jsonResponse(200, operationResult))
    }) as unknown as typeof fetch

    const client = new WalletStakeHttpClient({ ...baseOptions, fetchImpl })
    await client.release({
      operationId: 'battle:room-1:player:sub-1:stake:release',
      holdId: 'battle:room-1:player:sub-1:stake:reserve',
      reason: 'PARTICIPANT_LEFT',
    })

    expect(JSON.parse(capturedBody ?? '{}')).toEqual({
      operationId: 'battle:room-1:player:sub-1:stake:release',
      holdId: 'battle:room-1:player:sub-1:stake:reserve',
      reason: 'PARTICIPANT_LEFT',
    })
  })

  it('settle envia UNA llamada con todos los movimientos y parsea los resultados', async () => {
    let capturedUrl: string | undefined
    let capturedBody: string | undefined
    const fetchImpl = ((url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url
      capturedBody = init?.body as string

      return Promise.resolve(
        jsonResponse(200, {
          operationId: 'battle:room-1:stakes:settle',
          applied: true,
          results: [
            {
              playerId: 'sub-1',
              holdId: 'battle:room-1:player:sub-1:stake:reserve',
              balance: 90,
              reserved: 0,
              available: 90,
            },
          ],
        }),
      )
    }) as unknown as typeof fetch

    const client = new WalletStakeHttpClient({ ...baseOptions, fetchImpl })
    const result = await client.settle({
      operationId: 'battle:room-1:stakes:settle',
      battleId: 'room-1',
      settlements: [
        {
          playerId: 'sub-1',
          holdId: 'battle:room-1:player:sub-1:stake:reserve',
          outcome: 'CAPTURED',
          amount: 10,
        },
        {
          playerId: 'sub-2',
          holdId: 'battle:room-1:player:sub-2:stake:reserve',
          outcome: 'CREDITED',
          amount: 10,
        },
      ],
    })

    expect(capturedUrl).toBe('https://wallet.internal/api/internal/v1/wallet/stakes/settle')
    expect(result.results).toHaveLength(1)
    expect(JSON.parse(capturedBody ?? '{}')).toMatchObject({
      operationId: 'battle:room-1:stakes:settle',
      battleId: 'room-1',
    })
    expect(
      (JSON.parse(capturedBody ?? '{}') as { settlements: unknown[] }).settlements,
    ).toHaveLength(2)
  })

  it('409 se traduce a StakeOperationConflictError', async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(409, { code: 'OPERATION_CONFLICT' }))) as unknown as typeof fetch

    const client = new WalletStakeHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.reserve(reserveCommand)).rejects.toBeInstanceOf(StakeOperationConflictError)
  })

  it('422 conserva el code del contrato §11 (INSUFFICIENT_AVAILABLE_BALANCE)', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse(422, {
          code: 'INSUFFICIENT_AVAILABLE_BALANCE',
          message: 'sin disponible',
        }),
      )) as unknown as typeof fetch

    const client = new WalletStakeHttpClient({ ...baseOptions, fetchImpl })

    const outcome = client.reserve(reserveCommand)

    await expect(outcome).rejects.toBeInstanceOf(StakeRejectedError)
    await expect(outcome).rejects.toMatchObject({
      code: 'INSUFFICIENT_AVAILABLE_BALANCE',
      service: 'wallet',
    })
  })

  it('un 503 se traduce a UpstreamServiceError (reintentable con el mismo operationId)', async () => {
    const fetchImpl = (() => Promise.resolve(jsonResponse(503, {}))) as unknown as typeof fetch

    const client = new WalletStakeHttpClient({ ...baseOptions, fetchImpl })

    await expect(
      client.release({
        operationId: 'op',
        holdId: 'hold',
        reason: 'ROOM_CANCELLED',
      }),
    ).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it('un 400 CONSERVA el tratamiento previo (UpstreamServiceError): HU-23 no cambia con el arreglo de HU-22', async () => {
    // `postInternalJson` ahora distingue los 4xx permanentes, pero la apuesta
    // (creditos retenidos) no adopta esa clasificacion sin decidir antes que
    // hacen StakeSettler/StakeReleaser con un rechazo permanente.
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse(400, { message: ['amount must be an integer'] }),
      )) as unknown as typeof fetch

    const client = new WalletStakeHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.reserve(reserveCommand)).rejects.toMatchObject({
      name: 'UpstreamServiceError',
      reason: 'error_servidor',
    })
  })

  it('una respuesta con forma invalida lanza UpstreamServiceError, nunca completa campos', async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(200, { applied: true }))) as unknown as typeof fetch

    const client = new WalletStakeHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.reserve(reserveCommand)).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it('un fallo de red se traduce a UpstreamServiceError', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch

    const client = new WalletStakeHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.reserve(reserveCommand)).rejects.toBeInstanceOf(UpstreamServiceError)
  })
})
