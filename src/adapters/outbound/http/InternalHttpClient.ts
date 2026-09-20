import type { ClockPort } from '../../../application/ports/ClockPort'
import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import type { Logger } from '../../../infrastructure/observability/logger'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

/**
 * Cliente HTTP compartido de las integraciones internas de HU-15.2/RF-15
 * hacia Account y Player-Inventory (`AccountHttpClient.ts`,
 * `PlayerInventoryHttpClient.ts`).
 *
 * FIRMA CADA PETICION CON EL MISMO ESQUEMA HMAC-SHA256 que
 * `InternalServiceGuard` verifica en las rutas `@InternalOnly()` de Combat
 * (`adapters/inbound/http/auth/internal-service.guard.ts`): mismas cabeceras,
 * mismo `signInternalRequest`/`canonicalString`. Es DELIBERADO reutilizar
 * `internal-signature.ts` en las dos direcciones (servidor que verifica y
 * cliente que firma) -- es el mismo contrato HMAC en ambos sentidos, y
 * duplicarlo en un segundo fichero solo por ser "saliente" en vez de
 * "entrante" introduciria una segunda oportunidad de que las dos firmas
 * diverjan sin que ninguna prueba lo note.
 *
 * NUNCA REGISTRA EL SECRETO NI LA FIRMA CALCULADA (mismo criterio que
 * `InternalServiceGuard`): los mensajes de log solo llevan el servicio
 * destino, la ruta y la razon del fallo.
 */
export interface InternalHttpClientOptions {
  /** URL base del servicio destino, sin barra final (p. ej. `https://account.internal`). */
  readonly baseUrl: string
  /** Identidad de Combat al llamar a otro servicio (coincide con `INTERNAL_CALLERS` del destino). */
  readonly callerService: string
  readonly secret: string
  readonly clock: ClockPort
  readonly logger: Logger
  /** Milisegundos antes de abortar la peticion. */
  readonly timeoutMs?: number
  /** Inyectable para pruebas: por defecto, `fetch` global (Node >= 24). */
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 3_000

/**
 * Llama a `GET ${baseUrl}${path}` firmada, y devuelve el cuerpo JSON crudo
 * (`unknown`, sin validar forma: cada cliente concreto valida su propio
 * contrato) o `null` si el destino respondio 404 -- un 404 es, segun el
 * endpoint, un camino de negocio valido (`PlayerInventoryHttpClient`) o una
 * anomalia (`AccountHttpClient`); esta funcion no lo decide, solo lo
 * distingue de un fallo de transporte.
 *
 * Cualquier otro resultado no exitoso (no alcanzable, tiempo agotado, 401,
 * 5xx, cuerpo no parseable como JSON) lanza `UpstreamServiceError`.
 */
export type InternalGetResult =
  { readonly found: true; readonly body: unknown } | { readonly found: false }

export const getInternalJson = async (
  service: string,
  path: string,
  options: InternalHttpClientOptions,
): Promise<InternalGetResult> => {
  const method = 'GET'
  const timestamp = String(options.clock.now().getTime())
  const signature = signInternalRequest(options.secret, {
    service: options.callerService,
    method,
    path,
    timestamp,
    body: {},
  })

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetchImpl(`${options.baseUrl}${path}`, {
      method,
      headers: {
        [INTERNAL_SERVICE_HEADER]: options.callerService,
        [INTERNAL_TIMESTAMP_HEADER]: timestamp,
        [INTERNAL_SIGNATURE_HEADER]: signature,
        accept: 'application/json',
      },
      signal: controller.signal,
    })
  } catch (error: unknown) {
    const reason = isAbortError(error) ? 'tiempo_agotado' : 'no_alcanzable'

    options.logger.warn('internal_http_client_fallo', { service, path, reason })

    throw new UpstreamServiceError(service, reason)
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 404) {
    return { found: false as const }
  }

  if (response.status === 401 || response.status === 403) {
    options.logger.warn('internal_http_client_fallo', {
      service,
      path,
      reason: 'no_autorizado',
    })

    throw new UpstreamServiceError(service, 'no_autorizado')
  }

  if (!response.ok) {
    options.logger.warn('internal_http_client_fallo', {
      service,
      path,
      reason: 'error_servidor',
      status: response.status,
    })

    throw new UpstreamServiceError(service, 'error_servidor')
  }

  try {
    const body: unknown = await response.json()

    return { found: true as const, body }
  } catch {
    options.logger.warn('internal_http_client_fallo', {
      service,
      path,
      reason: 'respuesta_invalida',
    })

    throw new UpstreamServiceError(service, 'respuesta_invalida')
  }
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'
