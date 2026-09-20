import 'reflect-metadata'

import { AccountHttpClient } from '../../src/adapters/outbound/http/AccountHttpClient'
import { PlayerInventoryHttpClient } from '../../src/adapters/outbound/http/PlayerInventoryHttpClient'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import {
  AccountProfileMissingError,
  UpstreamServiceError,
} from '../../src/application/errors/UpstreamErrors'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { createHeroPower } from '../../src/domain/policies/HeroPowerPolicy'
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

    // Account monta TODAS sus rutas -incluidas las internas- bajo el prefijo
    // global `api` (`app.setGlobalPrefix(config.globalPrefix)` en
    // `Nexus-Battle-Account/src/main.ts`, por defecto `GLOBAL_PREFIX=api`,
    // sin excepcion para `@InternalOnly()`). Catalog ya lo hace bien para su
    // propio cliente interno (`EVIDENCE_PATH = '/api/internal/mfa-evidence/verification'`
    // en `AccountMfaEvidenceClient.ts`); `AccountHttpClient` debe seguir el
    // mismo patron. Sin el prefijo, la peticion no encuentra ninguna ruta y
    // Account responde 404 de framework -no de negocio- antes de que el
    // guard interno o el repositorio lleguen a intervenir.
    expect(capturedUrl).toBe(
      'https://account.internal/api/internal/accounts/sujeto-1/battle-profile',
    )
    expect(capturedHeaders?.[INTERNAL_SERVICE_HEADER]).toBe('combat')
    expect(capturedHeaders?.[INTERNAL_TIMESTAMP_HEADER]).toBe(String(NOW.getTime()))

    const expectedSignature = signInternalRequest(SECRET, {
      service: 'combat',
      method: 'GET',
      path: '/api/internal/accounts/sujeto-1/battle-profile',
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

  it('404 (subject verificado sin perfil) -> AccountProfileMissingError, NO UpstreamServiceError: HU-15.4, es informacion de negocio diagnosticable, no una caida de Account', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(jsonResponse(404, {}))
    const client = new AccountHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getBattleProfile('fantasma')).rejects.toBeInstanceOf(
      AccountProfileMissingError,
    )
    await expect(client.getBattleProfile('fantasma')).rejects.not.toBeInstanceOf(
      UpstreamServiceError,
    )
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

  it('firma la peticion con el mismo esquema HMAC que InternalServiceGuard verifica, contra la ruta REAL montada por Player-Inventory', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined

    const fetchImpl = ((url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url
      capturedHeaders = init?.headers as Record<string, string>

      return Promise.resolve(
        jsonResponse(200, {
          playerId: 'jugador-1',
          heroId: 'heroe-1',
          reference: 'referencia-catalogo',
          subtype: 'guerrero',
          name: 'Heroe Uno',
          baseStats: { ataque: 10 },
          effectiveStats: { power: 10, health: 44, defense: 11, attack: 12 },
          ready: true,
          selectedAt: '2026-09-19T00:00:00.000Z',
        }),
      )
    }) as unknown as typeof fetch

    const client = new PlayerInventoryHttpClient({ ...baseOptions, fetchImpl })
    const equipped = await client.getEquippedHero('jugador-1')

    // Player-Inventory monta TODAS sus rutas -incluidas las internas
    // `@InternalOnly()`- bajo su prefijo global (`app.setGlobalPrefix(config.globalPrefix)`
    // en `Nexus-Battle-Player-Inventory/src/main.ts`, `GLOBAL_PREFIX=api` por
    // defecto, sin excepcion para el contrato interno -- confirmado tanto
    // por el codigo fuente de ese repo como por su propia suite
    // (`test/integration/equipped-hero-http.spec.ts`, que golpea
    // `/api/internal/v1/players/:playerId/equipped-hero`). Es EXACTAMENTE el
    // mismo patron que ya se corrigio para `AccountHttpClient` (ver el test
    // de arriba): sin el prefijo, la peticion no encuentra ninguna ruta y
    // Player-Inventory responde 404 de framework -no el 404 de negocio
    // "sin heroe equipado"- antes de que el guard interno o el caso de uso
    // lleguen a intervenir. Ese 404 de framework se interpretaba
    // indistinguiblemente del 404 de negocio (ver comentario en
    // `PlayerInventoryHttpClient.getEquippedHero`), por lo que el defecto se
    // enmascaraba como "el jugador no tiene heroe equipado" para TODOS los
    // jugadores, tuvieran o no heroe equipado (hallazgo BLOQUEANTE-01 de la
    // auditoria HU-15.4).
    expect(capturedUrl).toBe(
      'https://player-inventory.internal/api/internal/v1/players/jugador-1/equipped-hero',
    )
    expect(capturedHeaders?.[INTERNAL_SERVICE_HEADER]).toBe('combat')
    expect(capturedHeaders?.[INTERNAL_TIMESTAMP_HEADER]).toBe(String(NOW.getTime()))

    const expectedSignature = signInternalRequest(SECRET, {
      service: 'combat',
      method: 'GET',
      path: '/api/internal/v1/players/jugador-1/equipped-hero',
      timestamp: String(NOW.getTime()),
      body: {},
    })
    expect(capturedHeaders?.[INTERNAL_SIGNATURE_HEADER]).toBe(expectedSignature)

    // Solo se modelan `playerId`, `heroId` y el Poder maximo (`effectiveStats.power`,
    // HU-11); el resto del cuerpo no llega al puerto.
    expect(equipped).toEqual({ playerId: 'jugador-1', heroId: 'heroe-1', maxPower: 10 })
  })

  it('el Poder maximo sale de effectiveStats.power, incluido 0 (Catalog admite basePower 0)', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse(200, {
          playerId: 'jugador-1',
          heroId: 'heroe-1',
          effectiveStats: { power: 0 },
        }),
      )
    const client = new PlayerInventoryHttpClient({ ...baseOptions, fetchImpl })

    await expect(client.getEquippedHero('jugador-1')).resolves.toEqual({
      playerId: 'jugador-1',
      heroId: 'heroe-1',
      maxPower: 0,
    })
  })

  it('el Poder maximo del contrato es el que arranca el Poder del participante (HU-11)', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse(200, {
          playerId: 'jugador-1',
          heroId: 'heroe-1',
          effectiveStats: { power: 12 },
        }),
      )
    const client = new PlayerInventoryHttpClient({ ...baseOptions, fetchImpl })

    const equipped = await client.getEquippedHero('jugador-1')
    if (equipped === null) throw new Error('se esperaba un heroe equipado')

    expect(createHeroPower(equipped.heroId, equipped.maxPower)).toEqual({
      heroId: 'heroe-1',
      current: 12,
      max: 12,
    })
  })

  it.each([
    ['sin effectiveStats', undefined],
    ['effectiveStats nulo', null],
    ['effectiveStats que no es un objeto', 'texto'],
    ['effectiveStats sin power', {}],
    ['power decimal', { power: 7.5 }],
    ['power negativo', { power: -1 }],
    ['power como texto', { power: '10' }],
    ['power nulo', { power: null }],
  ])(
    'respuesta invalida (%s) -> UpstreamServiceError: Combat no inventa el Poder maximo',
    async (_case, effectiveStats) => {
      const fetchImpl = (): Promise<Response> =>
        Promise.resolve(
          jsonResponse(200, { playerId: 'jugador-1', heroId: 'heroe-1', effectiveStats }),
        )
      const client = new PlayerInventoryHttpClient({ ...baseOptions, fetchImpl })

      await expect(client.getEquippedHero('jugador-1')).rejects.toBeInstanceOf(UpstreamServiceError)
    },
  )

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
