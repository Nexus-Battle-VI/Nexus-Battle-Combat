import 'reflect-metadata'

import { AccountHttpClient } from '../../src/adapters/outbound/http/AccountHttpClient'
import { PlayerInventoryHttpClient } from '../../src/adapters/outbound/http/PlayerInventoryHttpClient'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { Logger } from '../../src/infrastructure/observability/logger'

/**
 * Clientes HTTP internos de HU-15.2 (RF-15) hacia Account
 * (`AccountHttpClient`, DP-2) y Player-Inventory (`PlayerInventoryHttpClient`,
 * DP-4). `fetchImpl` se inyecta (nunca se golpea una red real): cada prueba
 * verifica UN aspecto del contrato -- firma HMAC saliente identica al
 * verificador (`InternalServiceGuard`), diferencia semantica del 404 entre
 * los dos clientes, y traduccion de fallos de transporte a
 * `UpstreamServiceError` sin dejar escapar el error crudo de `fetch`.
 */
const NOW = new Date('2026-09-19T10:00:00.000Z')
const SECRET = 'secreto-compartido-de-pruebas'
const clock: ClockPort = { now: () => NOW }

const logCalls: { level: string; message: string; context?: Record<string, unknown> }[] = []
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, context) => {
    logCalls.push({ level: 'warn', message, context })
  },
  error: (message, context) => {
    logCalls.push({ level: 'error', message, context })
  },
}

beforeEach(() => {
  logCalls.length = 0
})

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  }) as unknown as Response

describe('AccountHttpClient (HU-15.2, DP-2)', () => {
  const baseOptions = {
    baseUrl: 'https://account.internal',
    callerService: 'combat',
    secret: SECRET,
    clock,
    logger: silentLogger,
  }

  it('firma la peticion con el mismo esquema HMAC que InternalServiceGuard verifica', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined

    const fetchImpl = ((url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url
      capturedHeaders = init?.headers as Record<string, string>

      return Promise.resolve(
        jsonResponse(200, {
          subject: 'sujeto-1',
          displayName: 'Jugador Uno',
          avatarUrl: 'https://account.internal/accounts/sujeto-1/avatar',
        }),
      )
    }) as unknown as typeof fetch

    const client = new AccountHttpClient({ ...baseOptions, fetchImpl })
    const profile = await client.getBattleProfile('sujeto-1')

    expect(capturedUrl).toBe('https://account.internal/internal/accounts/sujeto-1/battle-profile')
    expect(capturedHeaders?.[INTERNAL_SERVICE_HEADER]).toBe('combat')
    expect(capturedHeaders?.[INTERNAL_TIMESTAMP_HEADER]).toBe(String(NOW.getTime()))

    const expectedSignature = signInternalRequest(SECRET, {
      service: 'combat',
      method: 'GET',
      path: '/internal/accounts/sujeto-1/battle-profile',
      timestamp: String(NOW.getTime()),
      body: {},
    })
    expect(capturedHeaders?.[INTERNAL_SIGNATURE_HEADER]).toBe(expectedSignature)

    expect(profile).toEqual({
      subject: 'sujeto-1',
      displayName: 'Jugador Uno',
      avatarUrl: 'https://account.internal/accounts/sujeto-1/avatar',
    })
  })

  it('avatarUrl null se acepta tal cual (ningun avatar configurado)', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(jsonResponse(200, { subject: 's', displayName: 'S', avatarUrl: null }))

    const client = new AccountHttpClient({ ...baseOptions, fetchImpl })
    const profile = await client.getBattleProfile('s')

    expect(profile.avatarUrl).toBeNull()
  })

  it('404 (subject verificado sin perfil) -> UpstreamServiceError, NO null: es una anomalia, no un camino de negocio', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(jsonResponse(404, {}))
    const client = new AccountHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getBattleProfile('fantasma')).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it('401 -> UpstreamServiceError sin filtrar el secreto ni la firma en el registro', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(jsonResponse(401, {}))
    const client = new AccountHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getBattleProfile('s')).rejects.toBeInstanceOf(UpstreamServiceError)
    for (const call of logCalls) {
      expect(JSON.stringify(call)).not.toContain(SECRET)
    }
  })

  it('5xx -> UpstreamServiceError', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(jsonResponse(503, {}))
    const client = new AccountHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getBattleProfile('s')).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it('cuerpo con forma invalida (displayName ausente) -> UpstreamServiceError, no un TypeError crudo', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(jsonResponse(200, { subject: 's', avatarUrl: null }))
    const client = new AccountHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getBattleProfile('s')).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it('fetch rechaza (no alcanzable) -> UpstreamServiceError, no el error crudo de red', async () => {
    const fetchImpl = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
    const client = new AccountHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getBattleProfile('s')).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it('tiempo de espera agotado (AbortError) -> UpstreamServiceError', async () => {
    const fetchImpl = (): Promise<Response> => {
      const abortError = new Error('The operation was aborted.')
      abortError.name = 'AbortError'
      return Promise.reject(abortError)
    }
    const client = new AccountHttpClient({ ...baseOptions, fetchImpl, timeoutMs: 10 })

    await expect(client.getBattleProfile('s')).rejects.toBeInstanceOf(UpstreamServiceError)
  })
})

describe('PlayerInventoryHttpClient (HU-15.2, DP-4)', () => {
  const baseOptions = {
    baseUrl: 'https://player-inventory.internal',
    callerService: 'combat',
    secret: SECRET,
    clock,
    logger: silentLogger,
  }

  it('resuelve heroId desde el contrato interno, sin modelar level (DP-3 no existe en el dominio)', async () => {
    let capturedUrl: string | undefined
    const fetchImpl = ((url: string): Promise<Response> => {
      capturedUrl = url
      return Promise.resolve(
        jsonResponse(200, {
          playerId: 'jugador-1',
          heroId: 'heroe-1',
          reference: 'referencia-catalogo',
          subtype: 'guerrero',
          name: 'Heroe Uno',
          baseStats: { ataque: 10 },
          effectiveStats: { ataque: 12 },
          ready: true,
          selectedAt: '2026-09-19T00:00:00.000Z',
        }),
      )
    }) as unknown as typeof fetch

    const client = new PlayerInventoryHttpClient({ ...baseOptions, fetchImpl })
    const equipped = await client.getEquippedHero('jugador-1')

    expect(capturedUrl).toBe(
      'https://player-inventory.internal/internal/v1/players/jugador-1/equipped-hero',
    )
    expect(equipped).toEqual({ playerId: 'jugador-1', heroId: 'heroe-1' })
  })

  it('404 (sin heroe equipado) -> null: A DIFERENCIA de Account, es un camino de negocio valido', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(jsonResponse(404, {}))
    const client = new PlayerInventoryHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getEquippedHero('sin-heroe')).resolves.toBeNull()
  })

  it('401 -> UpstreamServiceError', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(jsonResponse(401, {}))
    const client = new PlayerInventoryHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getEquippedHero('jugador-1')).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it('playerId de la respuesta no coincide con el pedido -> UpstreamServiceError (respuesta invalida)', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(jsonResponse(200, { playerId: 'otro-jugador', heroId: 'heroe-1' }))
    const client = new PlayerInventoryHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getEquippedHero('jugador-1')).rejects.toBeInstanceOf(UpstreamServiceError)
  })
})
