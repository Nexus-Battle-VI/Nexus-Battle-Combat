import 'reflect-metadata'

import { postInternalJson } from '../../src/adapters/outbound/http/InternalHttpClient'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { Logger } from '../../src/infrastructure/observability/logger'

/**
 * Clasificacion de las respuestas de `postInternalJson`. Antes solo 200/409/422
 * eran resultados; TODO lo demas (incluido un 400 permanente) era
 * `error_servidor`, es decir, transitorio y reintentable para siempre.
 */
const clock: ClockPort = { now: () => new Date('2026-09-24T00:00:00.000Z') }

const warnings: Record<string, unknown>[] = []
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (_message, context) => {
    warnings.push(context ?? {})
  },
  error: () => undefined,
}

beforeEach(() => {
  warnings.length = 0
})

const respond =
  (status: number, body: unknown): typeof fetch =>
  () =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
    } as unknown as Response)

const post = (fetchImpl: typeof fetch) =>
  postInternalJson(
    'player-inventory',
    '/api/internal/v1/inventory/grants',
    { a: 1 },
    {
      baseUrl: 'https://player-inventory.internal',
      callerService: 'combat',
      secret: 'secreto-compartido-de-pruebas',
      clock,
      logger,
      fetchImpl,
    },
  )

describe('postInternalJson: resultados de negocio', () => {
  it.each([
    [200, 'ok'],
    [409, 'conflict'],
    [422, 'rejected'],
  ])('%i -> outcome %s', async (status, outcome) => {
    await expect(post(respond(status, { x: 1 }))).resolves.toMatchObject({ outcome })
  })
})

describe('postInternalJson: 4xx PERMANENTE -> outcome invalid (no lanza, no se reintenta)', () => {
  it.each([400, 410, 413, 414, 415, 418, 431])('%i es permanente', async (status) => {
    await expect(post(respond(status, { message: 'no' }))).resolves.toMatchObject({
      outcome: 'invalid',
      status,
    })
  })

  it('registra el estado y la razon, sin cuerpo ni secreto', async () => {
    await post(respond(400, { message: ['operationId must be a UUID'] }))

    expect(warnings).toEqual([
      {
        service: 'player-inventory',
        path: '/api/internal/v1/inventory/grants',
        reason: 'peticion_invalida',
        status: 400,
      },
    ])
  })

  it('detalle: array de mensajes de NestJS -> unidos con "; "', async () => {
    await expect(
      post(respond(400, { message: ['operationId must be a UUID', 'items must not be empty'] })),
    ).resolves.toMatchObject({
      detail: 'operationId must be a UUID; items must not be empty',
    })
  })

  it('detalle: mensaje de texto -> tal cual', async () => {
    await expect(post(respond(400, { message: 'cuerpo invalido' }))).resolves.toMatchObject({
      detail: 'cuerpo invalido',
    })
  })

  it('detalle: acotado a 200 caracteres', async () => {
    const result = await post(respond(400, { message: 'x'.repeat(5_000) }))

    expect(result).toMatchObject({ outcome: 'invalid' })
    expect((result as { detail: string }).detail).toHaveLength(203)
    expect((result as { detail: string }).detail.endsWith('...')).toBe(true)
  })

  it.each([
    ['sin message', {}],
    ['message que no es texto', { message: { nested: true } }],
    ['message vacio', { message: '' }],
    ['array sin textos', { message: [1, 2] }],
    ['cuerpo que es un array', ['x']],
    ['cuerpo nulo', null],
    ['cuerpo que no es JSON', new SyntaxError('Unexpected token <')],
  ])('detalle nulo: %s (el 400 sigue siendo permanente)', async (_label, body) => {
    await expect(post(respond(400, body))).resolves.toEqual({
      outcome: 'invalid',
      status: 400,
      detail: null,
    })
  })

  it('el resultado NO devuelve el cuerpo completo del destino', async () => {
    const result = await post(respond(400, { message: 'no', internalTrace: 'secreto-interno' }))

    expect(JSON.stringify(result)).not.toContain('secreto-interno')
  })
})

describe('postInternalJson: fallos TRANSITORIOS -> UpstreamServiceError (reintentable con espera)', () => {
  it.each([404, 405, 408, 425, 429, 500, 501, 502, 503, 504])(
    '%i -> error_servidor',
    async (status) => {
      await expect(post(respond(status, {}))).rejects.toMatchObject({
        name: 'UpstreamServiceError',
        reason: 'error_servidor',
      })
    },
  )

  it.each([401, 403])('%i -> no_autorizado', async (status) => {
    await expect(post(respond(status, {}))).rejects.toMatchObject({
      reason: 'no_autorizado',
    })
  })

  it('red inalcanzable -> no_alcanzable', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch

    await expect(post(fetchImpl)).rejects.toMatchObject({ reason: 'no_alcanzable' })
    await expect(post(fetchImpl)).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it('un 200 con cuerpo que no es JSON -> respuesta_invalida (transitorio)', async () => {
    await expect(
      post(respond(200, new SyntaxError('Unexpected end of JSON'))),
    ).rejects.toMatchObject({
      reason: 'respuesta_invalida',
    })
  })
})
