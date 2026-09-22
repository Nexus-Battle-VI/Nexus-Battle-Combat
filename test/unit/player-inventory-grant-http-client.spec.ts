import 'reflect-metadata'

import { PlayerInventoryGrantHttpClient } from '../../src/adapters/outbound/http/PlayerInventoryGrantHttpClient'
import { RewardOperationConflictError } from '../../src/application/errors/RewardIntegrationErrors'
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
  baseUrl: 'https://player-inventory.internal',
  callerService: 'combat',
  secret: SECRET,
  clock,
  logger: silentLogger,
}

const command = {
  operationId: 'battle:room-1:player:sub-1:chest:1:grant',
  playerId: 'sub-1',
  productId: 'product-1',
  quantity: 1,
}

describe('PlayerInventoryGrantHttpClient (HU-22, reutiliza HU-59/HU-69 sin cambiar el contrato)', () => {
  it('envia exactamente el contrato ya vigente: un lote de un unico item', async () => {
    let capturedBody: string | undefined
    let capturedUrl: string | undefined

    const fetchImpl = ((url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url
      capturedBody = init?.body as string

      return Promise.resolve(jsonResponse(200, { applied: true }))
    }) as unknown as typeof fetch

    const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })
    const result = await client.grant(command)

    expect(capturedUrl).toBe('https://player-inventory.internal/api/internal/v1/inventory/grants')
    expect(JSON.parse(capturedBody ?? '{}')).toEqual({
      operationId: command.operationId,
      playerId: command.playerId,
      items: [{ productId: command.productId, quantity: 1 }],
    })
    expect(result).toEqual({ applied: true })
  })

  it('un replay (mismo operationId, applied:false) se propaga tal cual, sin reinterpretarlo', async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(200, { applied: false }))) as unknown as typeof fetch
    const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.grant(command)).resolves.toEqual({ applied: false })
  })

  it('409 (mismo operationId, otro payload) se traduce a RewardOperationConflictError', async () => {
    const fetchImpl = (() => Promise.resolve(jsonResponse(409, {}))) as unknown as typeof fetch
    const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.grant(command)).rejects.toThrow(RewardOperationConflictError)
  })

  it('422 INVENTORY_REJECTED se traduce a RewardRejectedError con su codigo', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse(422, { code: 'INVENTORY_REJECTED', message: 'inventario lleno' }),
      )) as unknown as typeof fetch
    const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.grant(command)).rejects.toMatchObject({
      name: 'RewardRejectedError',
      code: 'INVENTORY_REJECTED',
    })
  })

  it('un fallo de transporte se traduce a UpstreamServiceError', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ETIMEDOUT'))) as unknown as typeof fetch
    const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.grant(command)).rejects.toThrow(UpstreamServiceError)
  })
})
