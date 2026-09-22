export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export const AuthMode = {
  /**
   * Sin verificacion de identidad. Solo existe para desarrollo y pruebas: un
   * binario con `NODE_ENV=production` y este modo NO ARRANCA (ADR-004).
   */
  Disabled: 'disabled',
  /** Se exige un testimonio firmado por el user pool de Cognito. */
  Jwt: 'jwt',
} as const

export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode]

export interface CognitoConfig {
  readonly userPoolId: string
  readonly clientId: string
}

export const PersistenceDriver = {
  Memory: 'memory',
  Mongo: 'mongo',
} as const

export type PersistenceDriver = (typeof PersistenceDriver)[keyof typeof PersistenceDriver]

/**
 * Parametros del chat de Jugar Online (HU-13, RF-13).
 *
 * ORIGEN DE LAS CIFRAS. ADR-020 dice que la longitud y la frecuencia las fija
 * HU-13 y la Historia no da ninguna. Los valores por defecto son la propuesta
 * que el PO ratifico por chat (no consta por escrito en el issue):
 * 500 caracteres y 5 mensajes cada 10 segundos por remitente y canal.
 * `CHAT_RETENTION_HOURS` (168 = 7 dias) es la unica cifra sin ninguna fuente:
 * la eligio quien implemento y el PO debe fijarla. Por eso todo esto es
 * configuracion y no constantes.
 */
export interface ChatConfig {
  /** Longitud maxima del texto, en puntos de codigo Unicode. */
  readonly maxMessageLength: number
  /** Mensajes permitidos por remitente y canal dentro de la ventana. */
  readonly rateLimitMessages: number
  readonly rateLimitWindowMs: number
  /** Cuanto tiempo se conserva un mensaje persistido. */
  readonly retentionMs: number
  /** Tamano maximo del historial que se entrega al suscribirse (decision tecnica). */
  readonly historyLimit: number
}

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly serviceName: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  readonly port: number
  readonly globalPrefix: string
  readonly swaggerEnabled: boolean
  readonly persistenceDriver: PersistenceDriver
  readonly databaseUrl: string | null
  readonly authMode: AuthMode
  readonly cognito: CognitoConfig | null
  readonly internalServiceAuthSecret: string | null
  /** URL base de Account para el contrato interno `battle-profile` (HU-15.2, DP-2). Sin barra final. */
  readonly accountServiceBaseUrl: string | null
  /** URL base de Player-Inventory para el contrato interno `equipped-hero` (HU-15.2, DP-4). Sin barra final. */
  readonly playerInventoryServiceBaseUrl: string | null
  /** URL base de Wallet para el contrato interno `battle-reward` (HU-22, `hu-22-reward-contract-v1` §3). Sin barra final. */
  readonly walletServiceBaseUrl: string | null
  /** Tiempo de espera de las llamadas HTTP internas salientes (Account, Player-Inventory, Wallet). */
  readonly internalHttpTimeoutMs: number
  readonly chat: ChatConfig
  /**
   * Semilla con la que se inicializa la secuencia pseudoaleatoria de Combat al
   * arrancar (HU-17). Entero sin signo de 32 bits. Por defecto la semilla
   * validada por HU-26 (3.000.000). NO es una politica de semilla por batalla:
   * ver `docs/hu-17-turn-order.md`.
   */
  readonly randomSeed: number
}

/** Semilla de referencia validada por HU-26 (Management #362-#364). */
export const DEFAULT_RANDOM_SEED = 3_000_000

type RawEnv = Readonly<Record<string, string | undefined>>

const readEnum = <T extends string>(
  env: RawEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigurationError(
      `${key} debe ser uno de: ${allowed.join(', ')}. Se recibio "${raw}".`,
    )
  }

  return raw as T
}

const readInteger = (
  env: RawEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed)) {
    throw new ConfigurationError(`${key} debe ser un numero entero. Se recibio "${raw}".`)
  }

  if (parsed < min || parsed > max) {
    throw new ConfigurationError(
      `${key} debe estar entre ${String(min)} y ${String(max)}. Se recibio ${String(parsed)}.`,
    )
  }

  return parsed
}

const readString = (env: RawEnv, key: string, fallback: string): string => {
  const raw = env[key]

  return raw === undefined || raw === '' ? fallback : raw
}

const readBoolean = (env: RawEnv, key: string, fallback: boolean): boolean => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (raw !== 'true' && raw !== 'false') {
    throw new ConfigurationError(`${key} debe ser "true" o "false". Se recibio "${raw}".`)
  }

  return raw === 'true'
}

/**
 * Construye la configuracion a partir del entorno. Es una funcion pura sobre
 * `env`: no lee `process.env` directamente, de modo que puede verificarse por
 * completo sin contaminar el proceso de pruebas.
 *
 * Falla de inmediato ante una configuracion invalida. Un servicio mal
 * configurado no debe arrancar y aparentar salud.
 */
export const loadConfig = (env: RawEnv): AppConfig => {
  const nodeEnv = readEnum(
    env,
    'NODE_ENV',
    ['development', 'test', 'production'] as const,
    'development',
  )

  const persistenceDriver = readEnum(
    env,
    'PERSISTENCE_DRIVER',
    [PersistenceDriver.Memory, PersistenceDriver.Mongo],
    PersistenceDriver.Memory,
  )

  const databaseUrl = readString(env, 'MONGODB_URI', '')

  if (persistenceDriver === PersistenceDriver.Mongo && databaseUrl === '') {
    throw new ConfigurationError('MONGODB_URI es obligatorio cuando PERSISTENCE_DRIVER es "mongo".')
  }

  const authMode = readEnum(env, 'AUTH_MODE', [AuthMode.Disabled, AuthMode.Jwt], AuthMode.Disabled)

  if (nodeEnv === 'production' && authMode === AuthMode.Disabled) {
    throw new ConfigurationError(
      'AUTH_MODE no puede ser "disabled" con NODE_ENV=production. Sin verificacion de ' +
        'identidad el servicio no debe exponerse. Vease ADR-004.',
    )
  }

  const cognitoUserPoolId = readString(env, 'COGNITO_USER_POOL_ID', '')
  const cognitoClientId = readString(env, 'COGNITO_CLIENT_ID', '')

  if (authMode === AuthMode.Jwt && (cognitoUserPoolId === '' || cognitoClientId === '')) {
    throw new ConfigurationError(
      'COGNITO_USER_POOL_ID y COGNITO_CLIENT_ID son obligatorios cuando AUTH_MODE es "jwt".',
    )
  }

  // Se comprueba DESPUES de la identidad a proposito: la imagen sin configurar
  // debe negarse a arrancar nombrando AUTH_MODE, que es lo que verifica la CI.
  //
  // Una batalla que desaparece al reiniciar no puede reanudarse ni auditarse.
  // La persistencia en memoria es un doble de desarrollo y pruebas, nunca un
  // modo de produccion.
  if (nodeEnv === 'production' && persistenceDriver === PersistenceDriver.Memory) {
    throw new ConfigurationError(
      'PERSISTENCE_DRIVER no puede ser "memory" con NODE_ENV=production. Vease ADR-019.',
    )
  }

  const internalServiceAuthSecret = readString(env, 'INTERNAL_SERVICE_AUTH_SECRET', '')
  const accountServiceBaseUrl = readString(env, 'ACCOUNT_SERVICE_BASE_URL', '')
  const playerInventoryServiceBaseUrl = readString(env, 'PLAYER_INVENTORY_SERVICE_BASE_URL', '')
  const walletServiceBaseUrl = readString(env, 'WALLET_SERVICE_BASE_URL', '')

  // Igual que AUTH_MODE/PERSISTENCE_DRIVER: en produccion, HU-15.2 no puede
  // arrancar sin poder resolver displayName/heroId -- lo contrario dejaria
  // POST /v1/combat/rooms/:roomId/join fallando con 503 en cada peticion sin
  // que el arranque lo advirtiera.
  if (
    nodeEnv === 'production' &&
    (accountServiceBaseUrl === '' || playerInventoryServiceBaseUrl === '')
  ) {
    throw new ConfigurationError(
      'ACCOUNT_SERVICE_BASE_URL y PLAYER_INVENTORY_SERVICE_BASE_URL son obligatorios con ' +
        'NODE_ENV=production (HU-15.2, RF-15: resolucion de displayName/heroId al unirse).',
    )
  }

  // HU-22: sin esto, todo RewardWorkflow queda atascado en PENDING_CREDIT
  // desde la primera batalla que termine, sin que el arranque lo advierta.
  if (nodeEnv === 'production' && walletServiceBaseUrl === '') {
    throw new ConfigurationError(
      'WALLET_SERVICE_BASE_URL es obligatorio con NODE_ENV=production ' +
        '(HU-22, hu-22-reward-contract-v1 §3: acreditar creditos de batalla).',
    )
  }

  return {
    nodeEnv,
    serviceName: readString(env, 'SERVICE_NAME', 'nexus-battle-combat'),
    version: readString(env, 'SERVICE_VERSION', '0.1.0'),
    logLevel: readEnum(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    port: readInteger(env, 'PORT', 3006, 1, 65_535),
    globalPrefix: readString(env, 'GLOBAL_PREFIX', 'api'),
    // La documentacion interactiva permanece deshabilitada en produccion salvo
    // decision explicita: expone la superficie completa de la API.
    swaggerEnabled: readBoolean(env, 'SWAGGER_ENABLED', nodeEnv !== 'production'),
    persistenceDriver,
    databaseUrl: databaseUrl === '' ? null : databaseUrl,
    authMode,
    cognito:
      authMode === AuthMode.Jwt
        ? { userPoolId: cognitoUserPoolId, clientId: cognitoClientId }
        : null,
    internalServiceAuthSecret: internalServiceAuthSecret === '' ? null : internalServiceAuthSecret,
    accountServiceBaseUrl: accountServiceBaseUrl === '' ? null : accountServiceBaseUrl,
    playerInventoryServiceBaseUrl:
      playerInventoryServiceBaseUrl === '' ? null : playerInventoryServiceBaseUrl,
    walletServiceBaseUrl: walletServiceBaseUrl === '' ? null : walletServiceBaseUrl,
    internalHttpTimeoutMs: readInteger(env, 'INTERNAL_HTTP_TIMEOUT_MS', 3_000, 100, 30_000),
    chat: {
      // El tope 2000 acota lo que el validador del motor admite (8000 unidades,
      // hasta 4 bytes por punto de codigo): ver migracion 006.
      maxMessageLength: readInteger(env, 'CHAT_MAX_MESSAGE_LENGTH', 500, 1, 2_000),
      rateLimitMessages: readInteger(env, 'CHAT_RATE_LIMIT_MESSAGES', 5, 1, 100),
      rateLimitWindowMs: readInteger(env, 'CHAT_RATE_LIMIT_WINDOW_MS', 10_000, 1_000, 600_000),
      retentionMs: readInteger(env, 'CHAT_RETENTION_HOURS', 168, 1, 8_760) * 3_600_000,
      historyLimit: readInteger(env, 'CHAT_HISTORY_LIMIT', 50, 1, 200),
    },
    randomSeed: readInteger(env, 'COMBAT_RANDOM_SEED', DEFAULT_RANDOM_SEED, 0, 4_294_967_295),
  }
}
