import {
  ConfigurationError,
  loadConfig,
  PersistenceDriver,
} from '../../src/infrastructure/config/env'

describe('Configuracion del servicio', () => {
  it('arranca con valores por defecto de desarrollo', () => {
    const config = loadConfig({})

    expect(config).toMatchObject({
      nodeEnv: 'development',
      serviceName: 'nexus-battle-combat',
      port: 3006,
      globalPrefix: 'api',
      swaggerEnabled: true,
      persistenceDriver: PersistenceDriver.Memory,
      databaseUrl: null,
      internalServiceAuthSecret: null,
    })
  })

  it('lee los valores declarados en el entorno', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      SERVICE_NAME: 'otro-nombre',
      SERVICE_VERSION: '9.9.9',
      LOG_LEVEL: 'debug',
      PORT: '4000',
      GLOBAL_PREFIX: 'prefijo',
      SWAGGER_ENABLED: 'false',
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: 'mongodb://usuario@db/combat',
      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',
    })

    expect(config).toMatchObject({
      nodeEnv: 'test',
      serviceName: 'otro-nombre',
      version: '9.9.9',
      logLevel: 'debug',
      port: 4000,
      globalPrefix: 'prefijo',
      swaggerEnabled: false,
      persistenceDriver: PersistenceDriver.Mongo,
      databaseUrl: 'mongodb://usuario@db/combat',
      internalServiceAuthSecret: 'secreto',
    })
  })

  it('deshabilita la documentacion interactiva en produccion por defecto', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: 'mongodb://db/combat',
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_abc',
      COGNITO_CLIENT_ID: 'cliente',
      // HU-15.2 (RF-15): produccion tambien exige poder resolver
      // displayName/heroId al unirse (ver la prueba dedicada mas abajo,
      // "exige ACCOUNT_SERVICE_BASE_URL...").
      ACCOUNT_SERVICE_BASE_URL: 'https://account.internal',
      PLAYER_INVENTORY_SERVICE_BASE_URL: 'https://player-inventory.internal',
    })

    expect(config.swaggerEnabled).toBe(false)
  })

  it('exige ACCOUNT_SERVICE_BASE_URL y PLAYER_INVENTORY_SERVICE_BASE_URL en produccion (HU-15.2, RF-15)', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PERSISTENCE_DRIVER: 'mongo',
        MONGODB_URI: 'mongodb://db/combat',
        AUTH_MODE: 'jwt',
        COGNITO_USER_POOL_ID: 'us-east-1_abc',
        COGNITO_CLIENT_ID: 'cliente',
      }),
    ).toThrow(/ACCOUNT_SERVICE_BASE_URL/)
  })

  it('exige MONGODB_URI con el driver de MongoDB', () => {
    expect(() => loadConfig({ PERSISTENCE_DRIVER: 'mongo' })).toThrow(/MONGODB_URI/)
  })

  /**
   * Una batalla que desaparece al reiniciar no puede reanudarse ni auditarse.
   * El control es la prueba anterior de produccion completa: con persistencia
   * duradera si arranca.
   */
  it('impide arrancar en produccion con persistencia en memoria', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'jwt',
        COGNITO_USER_POOL_ID: 'us-east-1_abc',
        COGNITO_CLIENT_ID: 'cliente',
      }),
    ).toThrow(/PERSISTENCE_DRIVER/)
  })

  it.each([
    ['un entorno desconocido', { NODE_ENV: 'staging' }],
    ['un driver desconocido', { PERSISTENCE_DRIVER: 'postgres' }],
    ['un puerto no entero', { PORT: 'tres mil' }],
    ['un puerto fuera de rango', { PORT: '70000' }],
    ['un booleano ambiguo', { SWAGGER_ENABLED: 'si' }],
    ['un nivel de registro desconocido', { LOG_LEVEL: 'trace' }],
  ])('rechaza %s', (_caso, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigurationError)
  })
})
