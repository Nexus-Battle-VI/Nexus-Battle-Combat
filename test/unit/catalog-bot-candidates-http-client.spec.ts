import { CatalogBotCandidatesHttpClient } from '../../src/adapters/outbound/http/CatalogBotCandidatesHttpClient'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { Logger } from '../../src/infrastructure/observability/logger'
import { botCatalogCandidates } from '../fixtures/combat-bot-candidates'

const NOW = new Date('2026-10-04T19:00:00.000Z')
const SECRET = 'catalog-secret-for-tests'
const clock: ClockPort = { now: () => NOW }
const logger: Logger = {
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

describe('CatalogBotCandidatesHttpClient — contrato HU-93.1A', () => {
  it('usa ruta interna exacta, caller combat y firma HMAC canónica', async () => {
    let url = ''
    let headers: Record<string, string> = {}
    const body = botCatalogCandidates()
    const fetchImpl = ((requestedUrl: string, init?: RequestInit): Promise<Response> => {
      url = requestedUrl
      headers = init?.headers as Record<string, string>
      return Promise.resolve(jsonResponse(200, body))
    }) as unknown as typeof fetch
    const client = new CatalogBotCandidatesHttpClient({
      baseUrl: 'http://catalog:3003',
      callerService: 'combat',
      secret: SECRET,
      clock,
      logger,
      fetchImpl,
    })

    await expect(client.listBotCandidates()).resolves.toEqual(body)
    expect(url).toBe('http://catalog:3003/api/internal/v1/catalog/combat/bot-candidates')
    expect(headers[INTERNAL_SERVICE_HEADER]).toBe('combat')
    expect(headers[INTERNAL_TIMESTAMP_HEADER]).toBe(String(NOW.getTime()))
    expect(headers[INTERNAL_SIGNATURE_HEADER]).toBe(
      signInternalRequest(SECRET, {
        service: 'combat',
        method: 'GET',
        path: '/api/internal/v1/catalog/combat/bot-candidates',
        timestamp: String(NOW.getTime()),
        body: {},
      }),
    )
  })

  it.each([
    [{ ...botCatalogCandidates(), schemaVersion: '2' }],
    [
      {
        ...botCatalogCandidates(),
        abilities: [{ ...botCatalogCandidates().abilities[0], name: '' }],
      },
    ],
    [
      {
        ...botCatalogCandidates(),
        equipment: [
          {
            productId: 'p',
            sku: 's',
            type: 'ARMADURA',
            compatibilityScope: 'ALL_HEROES',
            effects: [],
          },
        ],
      },
    ],
  ])('rechaza schema futuro o estructura incompleta, sin inventar defaults', async (body) => {
    const client = new CatalogBotCandidatesHttpClient({
      baseUrl: 'http://catalog:3003',
      callerService: 'combat',
      secret: SECRET,
      clock,
      logger,
      fetchImpl: () => Promise.resolve(jsonResponse(200, body)),
    })

    await expect(client.listBotCandidates()).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it.each([
    ['dos habilidades', ['ability-1', 'ability-2']],
    ['cuatro habilidades', ['ability-1', 'ability-2', 'ability-3', 'ability-4']],
    ['habilidades duplicadas', ['ability-1', 'ability-2', 'ability-1']],
  ])('rechaza heroes con %s', async (_scenario, abilities) => {
    const candidates = botCatalogCandidates()
    const body = {
      ...candidates,
      heroes: [{ ...candidates.heroes[0], abilities }],
    }
    const client = new CatalogBotCandidatesHttpClient({
      baseUrl: 'http://catalog:3003',
      callerService: 'combat',
      secret: SECRET,
      clock,
      logger,
      fetchImpl: () => Promise.resolve(jsonResponse(200, body)),
    })

    await expect(client.listBotCandidates()).rejects.toMatchObject({
      name: 'UpstreamServiceError',
      service: 'catalog',
      reason: 'respuesta_invalida',
    })
  })
})
