import 'reflect-metadata'

import { PlayerInventoryGrantHttpClient } from '../../src/adapters/outbound/http/PlayerInventoryGrantHttpClient'
import { toInventoryGrantOperationId } from '../../src/adapters/outbound/http/inventory-grant-operation-id'
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
  baseUrl: 'https://player-inventory.internal',
  callerService: 'combat',
  secret: SECRET,
  clock,
  logger: silentLogger,
}

/**
 * Lo que Player-Inventory EXIGE de `operationId` (`GrantPurchasedItems.UUID_PATTERN`
 * y `@IsUUID()` del DTO, HU-59). Copiado a proposito: es el contrato del destino.
 */
const PLAYER_INVENTORY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Cuerpo real del 400 de Player-Inventory (capturado en produccion y en local). */
const BAD_REQUEST_BODY = {
  message: ['operationId must be a UUID'],
  error: 'Bad Request',
  statusCode: 400,
}

/** Doble de Player-Inventory con SU validacion real: 400 si `operationId` no es UUID. */
const playerInventoryLike =
  (calls: { operationId: unknown }[] = []): typeof fetch =>
  (_url, init) => {
    const body = JSON.parse((init?.body as string | undefined) ?? '{}') as { operationId: unknown }

    calls.push(body)

    return Promise.resolve(
      typeof body.operationId === 'string' && PLAYER_INVENTORY_UUID_PATTERN.test(body.operationId)
        ? jsonResponse(200, { applied: true })
        : jsonResponse(400, BAD_REQUEST_BODY),
    )
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
      operationId: toInventoryGrantOperationId(command.operationId),
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

  describe('operationId ante el contrato REAL de Player-Inventory (UUID v1-5)', () => {
    it('REGRESION: el id logico del workflow no es UUID, pero lo que viaja si: Player-Inventory lo acepta', async () => {
      const calls: { operationId: unknown }[] = []
      const client = new PlayerInventoryGrantHttpClient({
        ...baseOptions,
        fetchImpl: playerInventoryLike(calls),
      })

      // Control: el id logico, enviado tal cual, SI recibiria 400 de ese contrato.
      expect(PLAYER_INVENTORY_UUID_PATTERN.test(command.operationId)).toBe(false)

      await expect(client.grant(command)).resolves.toEqual({ applied: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.operationId).toMatch(PLAYER_INVENTORY_UUID_PATTERN)
      expect(calls[0]?.operationId).not.toBe(command.operationId)
    })

    it('un reintento del mismo workflow envia el MISMO UUID (idempotencia en Player-Inventory)', async () => {
      const calls: { operationId: unknown }[] = []
      const client = new PlayerInventoryGrantHttpClient({
        ...baseOptions,
        fetchImpl: playerInventoryLike(calls),
      })

      await client.grant(command)
      await client.grant(command)

      expect(calls[0]?.operationId).toBe(calls[1]?.operationId)
    })

    it('un workflow con otra secuencia de cofre envia otro UUID', async () => {
      const calls: { operationId: unknown }[] = []
      const client = new PlayerInventoryGrantHttpClient({
        ...baseOptions,
        fetchImpl: playerInventoryLike(calls),
      })

      await client.grant(command)
      await client.grant({ ...command, operationId: 'battle:room-1:player:sub-1:chest:2:grant' })

      expect(calls[0]?.operationId).not.toBe(calls[1]?.operationId)
    })

    it('un 409 informa el id LOGICO (el que se persiste y se registra), no el UUID del cable', async () => {
      const fetchImpl = (() => Promise.resolve(jsonResponse(409, {}))) as unknown as typeof fetch
      const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })

      await expect(client.grant(command)).rejects.toThrow(command.operationId)
    })
  })

  describe('clasificacion de errores: permanente vs transitorio', () => {
    it('400 -> RewardInvalidRequestError (PERMANENTE) con el motivo que dio Player-Inventory', async () => {
      const fetchImpl = (() =>
        Promise.resolve(jsonResponse(400, BAD_REQUEST_BODY))) as unknown as typeof fetch
      const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })

      const error: unknown = await client.grant(command).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(RewardInvalidRequestError)
      // Extiende RewardRejectedError: por eso ProcessRewardWorkflow lo lleva a TERMINAL_FAILURE.
      expect(error).toBeInstanceOf(RewardRejectedError)
      expect(error).not.toBeInstanceOf(UpstreamServiceError)
      expect(error).toMatchObject({
        name: 'RewardInvalidRequestError',
        status: 400,
        code: 'HTTP_400',
      })
      expect((error as Error).message).toContain('operationId must be a UUID')
    })

    it('un 400 con cuerpo que no es JSON tambien es permanente (sin detalle)', async () => {
      const fetchImpl = (() =>
        Promise.resolve({
          status: 400,
          ok: false,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        } as unknown as Response)) as unknown as typeof fetch
      const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })

      await expect(client.grant(command)).rejects.toBeInstanceOf(RewardInvalidRequestError)
    })

    it.each([404, 405, 408, 425, 429, 500, 502, 503, 504])(
      '%i -> UpstreamServiceError (TRANSITORIO: un reintento con espera puede resolverlo)',
      async (status) => {
        const fetchImpl = (() =>
          Promise.resolve(jsonResponse(status, {}))) as unknown as typeof fetch
        const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })

        const error: unknown = await client.grant(command).catch((caught: unknown) => caught)

        expect(error).toBeInstanceOf(UpstreamServiceError)
        expect(error).not.toBeInstanceOf(RewardRejectedError)
        expect(error).toMatchObject({ reason: 'error_servidor' })
      },
    )

    it.each([401, 403])(
      '%i -> UpstreamServiceError no_autorizado (transitorio: el secreto o el reloj pueden corregirse)',
      async (status) => {
        const fetchImpl = (() =>
          Promise.resolve(jsonResponse(status, {}))) as unknown as typeof fetch
        const client = new PlayerInventoryGrantHttpClient({ ...baseOptions, fetchImpl })

        await expect(client.grant(command)).rejects.toMatchObject({
          name: 'UpstreamServiceError',
          reason: 'no_autorizado',
        })
      },
    )
  })
})
