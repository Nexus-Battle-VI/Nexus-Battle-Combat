import 'reflect-metadata'

import { PlayerInventoryBattleCommitmentHttpClient } from '../../src/adapters/outbound/http/PlayerInventoryBattleCommitmentHttpClient'
import {
  BATTLE_COMMITMENT_NAMESPACE,
  toBattleCommitmentOperationId,
} from '../../src/adapters/outbound/http/battle-commitment-operation-id'
import { INVENTORY_GRANT_NAMESPACE } from '../../src/adapters/outbound/http/inventory-grant-operation-id'
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
 * Cliente del compromiso de batalla (HU-29, `hu-29-battle-commitment-v1` §3).
 *
 * Lo que se prueba aqui NO es la forma del JSON: es la CLAVE de idempotencia (el
 * `operationId` que viaja) y la traduccion de los rechazos del contrato. Si la
 * clave cambiara entre el compromiso y la liberacion, el heroe quedaria
 * comprometido para siempre.
 */

const NOW = new Date('2026-09-22T10:00:00.000Z')
const SECRET = 'secreto-compartido-de-pruebas'
const ROOM_ID = '11111111-1111-4111-8111-111111111111'
const PLAYER_ID = 'a1'
const HERO_ID = 'hero-a1'
const clock: ClockPort = { now: () => NOW }
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const jsonResponse = (status: number, body: unknown = {}): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  }) as unknown as Response

const baseOptions = {
  baseUrl: 'https://inventory.internal',
  callerService: 'combat',
  secret: SECRET,
  clock,
  logger: silentLogger,
}

const command = {
  roomId: ROOM_ID,
  playerId: PLAYER_ID,
  heroId: HERO_ID,
  expiresAt: new Date('2026-09-22T10:07:00.000Z'),
}

const clientWith = (fetchImpl: typeof fetch): PlayerInventoryBattleCommitmentHttpClient =>
  new PlayerInventoryBattleCommitmentHttpClient({ ...baseOptions, fetchImpl })

const asFetch = (handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch =>
  handler as unknown as typeof fetch

describe('compromiso de batalla — operationId (HU-29)', () => {
  it('es un UUID v5 DETERMINISTA por (sala, jugador): el reintento usa la misma clave', () => {
    const first = toBattleCommitmentOperationId(ROOM_ID, PLAYER_ID)

    expect(first).toBe('50178311-49a5-5fd6-a110-635e870d798e')
    expect(toBattleCommitmentOperationId(ROOM_ID, PLAYER_ID)).toBe(first)
    expect(toBattleCommitmentOperationId(ROOM_ID, 'b1')).not.toBe(first)
    expect(toBattleCommitmentOperationId('otra-sala', PLAYER_ID)).not.toBe(first)
  })

  it('no comparte espacio de nombres con las ENTREGAS de HU-22', () => {
    expect(BATTLE_COMMITMENT_NAMESPACE).not.toBe(INVENTORY_GRANT_NAMESPACE)
  })
})

describe('PlayerInventoryBattleCommitmentHttpClient (HU-29, contrato §3)', () => {
  it('commit firma la peticion, apunta al heroe y envia la clave y el vencimiento', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    let capturedBody: string | undefined

    const client = clientWith(
      asFetch((url, init) => {
        capturedUrl = url
        capturedHeaders = init?.headers as Record<string, string>
        capturedBody = init?.body as string

        return Promise.resolve(jsonResponse(201))
      }),
    )

    await client.commit(command)

    expect(capturedUrl).toBe(
      `https://inventory.internal/api/internal/v1/inventory/heroes/${HERO_ID}/battle-commitments`,
    )
    expect(JSON.parse(capturedBody ?? '{}')).toEqual({
      operationId: toBattleCommitmentOperationId(ROOM_ID, PLAYER_ID),
      playerId: PLAYER_ID,
      reference: ROOM_ID,
      expiresAt: '2026-09-22T10:07:00.000Z',
    })

    const timestamp = capturedHeaders?.[INTERNAL_TIMESTAMP_HEADER] ?? ''
    const expectedSignature = signInternalRequest(SECRET, {
      service: 'combat',
      method: 'POST',
      path: `/api/internal/v1/inventory/heroes/${HERO_ID}/battle-commitments`,
      timestamp,
      body: JSON.parse(capturedBody ?? '{}') as unknown,
    })

    expect(capturedHeaders?.[INTERNAL_SERVICE_HEADER]).toBe('combat')
    expect(capturedHeaders?.[INTERNAL_SIGNATURE_HEADER]).toBe(expectedSignature)
  })

  it('release usa la MISMA clave que el compromiso y acepta el 204 sin cuerpo', async () => {
    const urls: string[] = []
    const bodies: string[] = []

    const client = clientWith(
      asFetch((url, init) => {
        urls.push(url)
        bodies.push(init?.body as string)

        return Promise.resolve(
          jsonResponse(url.includes('/release') ? 204 : 201, url.includes('/release') ? null : {}),
        )
      }),
    )

    await client.commit(command)
    await client.release(ROOM_ID, PLAYER_ID)

    const operationId = toBattleCommitmentOperationId(ROOM_ID, PLAYER_ID)

    expect(urls[1]).toBe(
      `https://inventory.internal/api/internal/v1/inventory/battle-commitments/${operationId}/release`,
    )
    expect(JSON.parse(bodies[0] ?? '{}')).toMatchObject({ operationId })
    expect(JSON.parse(bodies[1] ?? '{}')).toEqual({})
  })

  it('409 -> `operation_id_reutilizado` (la clave ya existe con otro cuerpo)', async () => {
    const client = clientWith(
      asFetch(() => Promise.resolve(jsonResponse(409, { reason: 'battle_lock' }))),
    )

    await expect(client.commit(command)).rejects.toMatchObject({
      name: 'UpstreamServiceError',
      service: 'player-inventory',
      reason: 'operation_id_reutilizado',
    })
  })

  it('422 -> `heroe_no_disponible` (el heroe no es de ese jugador o ya esta en otra batalla)', async () => {
    const client = clientWith(
      asFetch(() =>
        Promise.resolve(jsonResponse(422, { reason: 'battle_lock', message: 'ocupado' })),
      ),
    )

    await expect(client.commit(command)).rejects.toMatchObject({
      name: 'UpstreamServiceError',
      service: 'player-inventory',
      reason: 'heroe_no_disponible',
    })
    await expect(client.release(ROOM_ID, PLAYER_ID)).rejects.toBeInstanceOf(UpstreamServiceError)
  })

  it('un 404 (Player/Inventory sin la ruta: orden de despliegue) se propaga', async () => {
    const client = clientWith(asFetch(() => Promise.resolve(jsonResponse(404))))

    await expect(client.commit(command)).rejects.toMatchObject({
      name: 'UpstreamServiceError',
      reason: 'error_servidor',
    })
  })

  it('un 400 PERMANENTE se distingue por su codigo: no se reintenta a ciegas', async () => {
    const client = clientWith(
      asFetch(() =>
        Promise.resolve(jsonResponse(400, { message: ['expiresAt must be a future date'] })),
      ),
    )

    await expect(client.commit(command)).rejects.toMatchObject({
      name: 'UpstreamServiceError',
      service: 'player-inventory',
      reason: 'peticion_invalida_400',
    })
  })

  it('un fallo de red se propaga como `no_alcanzable`', async () => {
    const client = clientWith(asFetch(() => Promise.reject(new Error('ECONNREFUSED'))))

    await expect(client.commit(command)).rejects.toMatchObject({
      name: 'UpstreamServiceError',
      reason: 'no_alcanzable',
    })
  })
})
