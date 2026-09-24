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

/**
 * Resultado de una llamada `POST` interna firmada (HU-22): la forma del
 * cuerpo la valida cada cliente concreto (`WalletHttpClient`,
 * `PlayerInventoryGrantHttpClient`), esta funcion solo distingue los
 * resultados de transporte/protocolo que HU-22 documenta como negocio, no
 * como fallo:
 *
 *  - `ok`: `200`, cuerpo JSON crudo.
 *  - `conflict`: `409` (mismo `operationId`, cuerpo distinto).
 *  - `rejected`: `422` (rechazo terminal de negocio; el cuerpo trae `code`/`message`).
 *  - `invalid`: `4xx` PERMANENTE (`400`, `413`, `415`...): el destino rechazo
 *    la peticion misma y responderia igual a cualquier reintento con el mismo
 *    cuerpo. `detail` es su mensaje de validacion, acotado, o `null`.
 *
 * Solo lanzan `UpstreamServiceError` los fallos TRANSITORIOS, los que un
 * reintento con espera puede resolver: no alcanzable, tiempo agotado, 5xx,
 * 401/403 (secreto o reloj mal configurados), 404/405 (el destino aun no
 * tiene la ruta: orden de despliegue), 408/425/429 (tiempo o carga) y un
 * cuerpo no parseable.
 */
export type InternalPostResult =
  | { readonly outcome: 'ok'; readonly body: unknown }
  | { readonly outcome: 'conflict'; readonly body: unknown }
  | { readonly outcome: 'rejected'; readonly body: unknown }
  | { readonly outcome: 'invalid'; readonly status: number; readonly detail: string | null }

/**
 * `4xx` cuya causa NO esta en el cuerpo enviado sino en el estado o el
 * despliegue del destino, asi que reintentar con espera puede resolverlos. El
 * resto de los `4xx` (salvo 409/422, ya de negocio) es permanente.
 * 401/403 se tratan antes, como `no_autorizado`.
 */
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([404, 405, 408, 425, 429])

const isPermanentRequestError = (status: number): boolean =>
  status >= 400 &&
  status < 500 &&
  status !== 409 &&
  status !== 422 &&
  !RETRYABLE_CLIENT_STATUSES.has(status)

const MAX_DETAIL_LENGTH = 200

/**
 * Mensaje de validacion del destino (`{"message": string | string[]}`, forma de
 * NestJS), acotado. Nunca devuelve el cuerpo completo ni valores enviados:
 * solo texto que el destino escribio para explicar el rechazo.
 */
const describeInvalidRequest = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null
  }

  const message = (body as Readonly<Record<string, unknown>>).message
  const text = Array.isArray(message)
    ? message.filter((entry): entry is string => typeof entry === 'string').join('; ')
    : message

  if (typeof text !== 'string' || text.length === 0) {
    return null
  }

  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}...` : text
}

export const postInternalJson = async (
  service: string,
  path: string,
  payload: unknown,
  options: InternalHttpClientOptions,
): Promise<InternalPostResult> => {
  const method = 'POST'
  const timestamp = String(options.clock.now().getTime())
  const signature = signInternalRequest(options.secret, {
    service: options.callerService,
    method,
    path,
    timestamp,
    body: payload,
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
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (error: unknown) {
    const reason = isAbortError(error) ? 'tiempo_agotado' : 'no_alcanzable'

    options.logger.warn('internal_http_client_fallo', { service, path, reason })

    throw new UpstreamServiceError(service, reason)
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401 || response.status === 403) {
    options.logger.warn('internal_http_client_fallo', {
      service,
      path,
      reason: 'no_autorizado',
    })

    throw new UpstreamServiceError(service, 'no_autorizado')
  }

  if (isPermanentRequestError(response.status)) {
    options.logger.warn('internal_http_client_fallo', {
      service,
      path,
      reason: 'peticion_invalida',
      status: response.status,
    })

    const body: unknown = await response.json().catch(() => null)

    return {
      outcome: 'invalid' as const,
      status: response.status,
      detail: describeInvalidRequest(body),
    }
  }

  if (response.status !== 200 && response.status !== 409 && response.status !== 422) {
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

    if (response.status === 409) {
      return { outcome: 'conflict' as const, body }
    }

    if (response.status === 422) {
      return { outcome: 'rejected' as const, body }
    }

    return { outcome: 'ok' as const, body }
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
