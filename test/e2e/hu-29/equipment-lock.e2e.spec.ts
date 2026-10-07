/* eslint-disable @typescript-eslint/no-explicit-any -- las respuestas HTTP de los dos servicios reales son JSON dinamico; el contrato se verifica con las aserciones, no con tipos */
import 'reflect-metadata'

import { randomUUID } from 'node:crypto'
import { type ChildProcessWithoutNullStreams, spawn, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import fs from 'node:fs'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { type Db, type MongoClient } from 'mongodb'
import request from 'supertest'

import {
  ACCOUNT_BATTLE_PROFILE,
  type AccountBattleProfilePort,
} from '../../../src/application/ports/AccountBattleProfilePort'
import {
  PLAYER_INVENTORY_EQUIPPED_HERO,
  type PlayerInventoryEquippedHeroPort,
} from '../../../src/application/ports/PlayerInventoryEquippedHeroPort'
import {
  BATTLE_DEADLINE_SCHEDULER_OPTIONS,
  PROCESS_BATTLE_DEADLINES,
  REWARD_WORKFLOW_SCHEDULER_OPTIONS,
} from '../../../src/adapters/inbound/http/tokens'
import { RECONCILE_REWARD_WORKFLOWS } from '../../../src/adapters/inbound/http/tokens'
import type { ProcessBattleDeadlines } from '../../../src/application/use-cases/ProcessBattleDeadlines'
import type { ReconcileRewardWorkflows } from '../../../src/application/use-cases/ReconcileRewardWorkflows'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../../src/application/ports/TokenVerifierPort'
import { REALTIME_GATEWAY_OPTIONS } from '../../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import { CLOCK, type ClockPort } from '../../../src/application/ports/ClockPort'
import { BATTLE_HERO_COMMITMENTS } from '../../../src/application/ports/BattleHeroCommitmentPort'
import { PlayerInventoryBattleCommitmentHttpClient } from '../../../src/adapters/outbound/http/PlayerInventoryBattleCommitmentHttpClient'
import { LOGGER } from '../../../src/infrastructure/observability/logger-token'
import type { Logger } from '../../../src/infrastructure/observability/logger'
import { AppModule, OUTBOUND_SERVICE_NAME } from '../../../src/infrastructure/bootstrap/app.module'
import {
  createMongoClient as createCombatMongoClient,
  databaseOf as combatDatabaseOf,
  migrateToLatest as migrateCombatToLatest,
} from '../../../src/infrastructure/persistence/database'
import { describeError } from '../../../src/infrastructure/observability/describe-error'
import {
  signInternalRequest,
  INTERNAL_SERVICE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  INTERNAL_SIGNATURE_HEADER,
} from '../../../src/adapters/outbound/identity/internal-signature'
import { equippedHeroFixture } from '../../fixtures/equipped-hero'
import { MutableClock } from '../../fixtures/chat-harness'

/**
 * HU-29 de extremo a extremo, REAL: Combat real (este proceso, HTTP real) ->
 * HMAC real -> Player-Inventory real (proceso Node aparte, su build de
 * verdad) -> MongoDB real (Testcontainers, un contenedor POR servicio, sin
 * compartir esquema -- ADR-001). Ver `jest.e2e-hu29.config.ts` para por que
 * esto vive fuera de `test:db`/CI.
 *
 * REAL en esta prueba: el ciclo de vida de la sala de Combat (create / join /
 * start / vencimiento global -> finish), `BattleHeroCommitmentPort` con su
 * adaptador HTTP real y la firma HMAC real, las dos rutas internas de
 * Player-Inventory, su repositorio de compromisos de batalla y su
 * repositorio de loadout contra Mongo real, y los endpoints publicos
 * GET/PUT de equipamiento contra ese mismo Mongo real.
 *
 * SUSTITUIDO, declarado explicitamente, por ser ajeno a HU-29 e
 * imprescindible solo para construir el fixture:
 * - `ACCOUNT_BATTLE_PROFILE` y `PLAYER_INVENTORY_EQUIPPED_HERO` de Combat
 *   (HU-15/HU-16: perfil de cuenta y heroe equipado para la elegibilidad
 *   precombate). Devuelven datos fijos coherentes con lo sembrado en el
 *   Player-Inventory real.
 * - `TOKEN_VERIFIER` de Combat (JWT/Cognito no es parte de HU-29).
 * - El propio `CatalogReadPort` de Player-Inventory: se apunta
 *   `CATALOG_BASE_URL` a un servidor HTTP minimo levantado por esta prueba,
 *   que sirve el contrato canonico de Catalog v1 para un heroe y sus tres
 *   piezas equipables. Catalog es HU-27, no HU-29; sin el, Player-Inventory
 *   no podria resolver ningun producto y no habria heroe que equipar.
 * - El RELOJ que firma el HMAC saliente de Combat (no el puerto ni la
 *   clase): `BattleHeroCommitmentPort` sigue siendo el adaptador HTTP REAL
 *   (`PlayerInventoryBattleCommitmentHttpClient`, sin doblar), pero se
 *   construye con un reloj de tiempo real para el sello de la firma, en vez
 *   del reloj de juego mutable de esta prueba (que se adelanta 6 minutos
 *   para HU-21/E-10). Player-Inventory verifica la firma contra SU propio
 *   reloj de pared real con una ventana de 30 s; firmar con un reloj de
 *   juego adelantado la rompería. Ver el comentario junto a
 *   `overrideProvider(BATTLE_HERO_COMMITMENTS)`.
 *
 * El estado de bloqueo NUNCA se simula: empezar la batalla es un POST real
 * de Combat a Player-Inventory (compromiso `BATTLE`) y terminarla es un
 * POST real de liberacion, exactamente la cadena que describe el contrato
 * `hu-29-battle-commitment-v1`.
 */

const PLAYER_ID = 'anonymous' // AUTH_MODE=disabled en Player-Inventory atribuye toda peticion a este sujeto.
const COMBAT_TOKEN = 'token-humano'
const INTERNAL_SECRET = 'secreto-e2e-hu-29'

const HERO_PRODUCT_ID = randomUUID()
const WEAPON_PRODUCT_ID = randomUUID()
// Arma SEPARADA para WEAPON_2: reusar WEAPON_PRODUCT_ID (ya equipada en
// WEAPON_1 desde E-01) chocaria con la regla de HU-28 "el mismo objeto no se
// equipa dos veces" -- un 409 real, pero de OTRA regla, no de HU-29.
const WEAPON2_PRODUCT_ID = randomUUID()
const ARMOR_PRODUCT_ID = randomUUID()
const ITEM_PRODUCT_ID = randomUUID()

const PI_REPO_PATH =
  process.env.PLAYER_INVENTORY_REPO_PATH ??
  path.resolve(__dirname, '../../../../../Player-Inventory/Nexus-Battle-Player-Inventory')

// -----------------------------------------------------------------------
// Fixtures de Catalog v1 (mismo sobre canonico que
// Player-Inventory/test/unit/hu-29-3-matriz-bloqueo.spec.ts, para heredar su
// evidencia de que esta forma es la que el dominio real acepta).
// -----------------------------------------------------------------------
const catalogProducts: Record<string, unknown> = {
  [HERO_PRODUCT_ID]: {
    productId: HERO_PRODUCT_ID,
    sku: 'guerrero-tanque-e2e',
    name: 'Guerrero Tanque (E2E HU-29)',
    imageUrl: 'https://assets.example.test/guerrero-tanque.png',
    description: 'Heroe de la prueba de extremo a extremo de HU-29.',
    type: 'HEROE',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 0,
    premium: false,
    realMoneyPrice: null,
    attributes: {
      schemaVersion: '1',
      values: {
        kind: 'HEROE',
        heroSubtype: 'GUERRERO_TANQUE',
        basePower: 5,
        baseHealth: 40,
        baseDefense: 8,
        baseAttack: { mode: 'FIXED', amount: 10 },
        abilities: [],
      },
    },
  },
  [WEAPON_PRODUCT_ID]: {
    productId: WEAPON_PRODUCT_ID,
    sku: 'espada-e2e',
    name: 'Espada (E2E HU-29)',
    imageUrl: 'https://assets.example.test/espada.png',
    description: 'Arma de la prueba de extremo a extremo de HU-29.',
    type: 'ARMA',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 10,
    premium: false,
    realMoneyPrice: null,
    attributes: {
      schemaVersion: '1',
      values: {
        kind: 'ARMA',
        compatibilityScope: 'ALL_HEROES',
        effects: [
          {
            kind: 'STAT_MODIFIER',
            target: 'SELF',
            statistic: 'ATTACK',
            operation: 'INCREASE',
            magnitude: { mode: 'FIXED', amount: 2 },
          },
        ],
      },
    },
  },
  [WEAPON2_PRODUCT_ID]: {
    productId: WEAPON2_PRODUCT_ID,
    sku: 'hacha-e2e',
    name: 'Hacha (E2E HU-29)',
    imageUrl: 'https://assets.example.test/hacha.png',
    description: 'Segunda arma de la prueba de extremo a extremo de HU-29 (ranura WEAPON_2).',
    type: 'ARMA',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 10,
    premium: false,
    realMoneyPrice: null,
    attributes: {
      schemaVersion: '1',
      values: {
        kind: 'ARMA',
        compatibilityScope: 'ALL_HEROES',
        effects: [
          {
            kind: 'STAT_MODIFIER',
            target: 'SELF',
            statistic: 'ATTACK',
            operation: 'INCREASE',
            magnitude: { mode: 'FIXED', amount: 1 },
          },
        ],
      },
    },
  },
  [ARMOR_PRODUCT_ID]: {
    productId: ARMOR_PRODUCT_ID,
    sku: 'casco-e2e',
    name: 'Casco (E2E HU-29)',
    imageUrl: 'https://assets.example.test/casco.png',
    description: 'Armadura de la prueba de extremo a extremo de HU-29.',
    type: 'ARMADURA',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 10,
    premium: false,
    realMoneyPrice: null,
    attributes: {
      schemaVersion: '1',
      values: {
        kind: 'ARMADURA',
        slot: 'HEAD',
        compatibilityScope: 'ALL_HEROES',
        effects: [],
      },
    },
  },
  [ITEM_PRODUCT_ID]: {
    productId: ITEM_PRODUCT_ID,
    sku: 'amuleto-e2e',
    name: 'Amuleto (E2E HU-29)',
    imageUrl: 'https://assets.example.test/amuleto.png',
    description: 'Item de la prueba de extremo a extremo de HU-29.',
    type: 'ITEM',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 10,
    premium: false,
    realMoneyPrice: null,
    attributes: {
      schemaVersion: '1',
      values: {
        kind: 'ITEM',
        compatibilityScope: 'ALL_HEROES',
        effects: [],
      },
    },
  },
}

const startCatalogMock = async (): Promise<{ server: Server; baseUrl: string }> => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = /^\/api\/v1\/catalog\/products\/([^/]+)$/u.exec(url.pathname)

    if (process.env.HU29_E2E_DEBUG === '1') {
      process.stderr.write(`[catalog-mock] ${req.method ?? '?'} ${req.url ?? '?'}\n`)
    }

    if (req.method === 'GET' && match) {
      const reference = decodeURIComponent(match[1] ?? '')
      const product = catalogProducts[reference]

      res.writeHead(product === undefined ? 404 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(product ?? { message: 'no encontrado' }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/catalog/products/lookup') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          readonly references?: readonly string[]
        }
        const references = parsed.references ?? []
        const items = references
          .map((reference) => catalogProducts[reference])
          .filter((product) => product !== undefined)

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ items }))
      })
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'ruta no servida por el doble de Catalog' }))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('El doble de Catalog no pudo resolver su puerto.')
  }

  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` }
}

// -----------------------------------------------------------------------
// Player-Inventory real: build de produccion + proceso Node aparte.
// -----------------------------------------------------------------------
const waitForHealth = async (baseUrl: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health/live`)
      if (response.ok) return
    } catch {
      // Todavia no escucha: se reintenta hasta el plazo.
    }

    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  throw new Error(`Player-Inventory no respondio sano en ${String(timeoutMs)} ms.`)
}

const runToCompletion = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { readonly stdout: string; readonly stderr: string } => {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    return { stdout, stderr: '' }
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error(
      `Comando "${command} ${args.join(' ')}" fallo en ${cwd}.\n` +
        `stdout:\n${execError.stdout ?? ''}\nstderr:\n${execError.stderr ?? execError.message ?? String(error)}`,
      { cause: error },
    )
  }
}

interface PlayerInventoryProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly baseUrl: string
  readonly logs: string[]
}

const startPlayerInventory = async (options: {
  readonly mongoUri: string
  readonly catalogBaseUrl: string
}): Promise<PlayerInventoryProcess> => {
  if (!fs.existsSync(PI_REPO_PATH)) {
    throw new Error(
      `No se encontro Nexus-Battle-Player-Inventory en "${PI_REPO_PATH}". Este spec necesita ` +
        'el repo hermano en el mismo checkout multirepo (o PLAYER_INVENTORY_REPO_PATH). Ver ' +
        'jest.e2e-hu29.config.ts.',
    )
  }

  const sharedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PERSISTENCE_DRIVER: 'mongo',
    MONGODB_URI: options.mongoUri,
    AUTH_MODE: 'disabled',
    INTERNAL_SERVICE_AUTH_SECRET: INTERNAL_SECRET,
    CATALOG_BASE_URL: options.catalogBaseUrl,
    SWAGGER_ENABLED: 'false',
    LOG_LEVEL: 'warn',
  }

  // 1) Build de verdad (nest build / tsc), la MISMA imagen que correria en
  //    despliegue: `node dist/main.js`. No ts-node: no es una dependencia
  //    instalada en este repo.
  runToCompletion('npm', ['run', 'build'], sharedEnv, PI_REPO_PATH)

  // 2) Migraciones, paso explicito, igual que en despliegue real (ver
  //    Infrastructure/compose/compose.yml: `*-migrate` antes del servicio).
  runToCompletion('node', ['dist/infrastructure/persistence/migrate.js'], sharedEnv, PI_REPO_PATH)

  // 3) El servicio real, en un puerto libre.
  const port = 20_000 + Math.floor(Math.random() * 10_000)
  const env: NodeJS.ProcessEnv = { ...sharedEnv, PORT: String(port) }
  const child = spawn('node', ['dist/main.js'], { cwd: PI_REPO_PATH, env })
  const logs: string[] = []

  child.stdout.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')))
  child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')))

  const baseUrl = `http://127.0.0.1:${String(port)}`

  try {
    await waitForHealth(baseUrl, 60_000)
  } catch (error: unknown) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nSalida de Player-Inventory:\n${logs.join('')}`,
      { cause: error },
    )
  }

  return { child, baseUrl, logs }
}

// -----------------------------------------------------------------------
// Llamada interna firmada a Player-Inventory, con el MISMO esquema HMAC que
// usa el cliente real de Combat (`internal-signature.ts`, mismo repo, sin
// reimplementarlo). Solo para sembrar el fixture (otorgar productos) --
// `combat` ya esta en el `@InternalCallers` de esa ruta en Player-Inventory,
// asi que esta llamada usa una autorizacion real, no un atajo.
// -----------------------------------------------------------------------
const signedInternalPost = async (
  baseUrl: string,
  path_: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const timestamp = Date.now().toString()
  const signature = signInternalRequest(INTERNAL_SECRET, {
    service: 'combat',
    method: 'POST',
    path: path_,
    timestamp,
    body,
  })

  const response = await fetch(`${baseUrl}${path_}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [INTERNAL_SERVICE_HEADER]: 'combat',
      [INTERNAL_TIMESTAMP_HEADER]: timestamp,
      [INTERNAL_SIGNATURE_HEADER]: signature,
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
}

// -----------------------------------------------------------------------
// Combat real (en proceso, HTTP real sobre un puerto efimero -- mismo patron
// que test/db/battle-finish.e2e.spec.ts).
// -----------------------------------------------------------------------
const verifier: TokenVerifierPort = {
  verify: (token) =>
    token === COMBAT_TOKEN
      ? Promise.resolve({ subject: PLAYER_ID, email: null, roles: new Set([Role.Player]) })
      : Promise.reject(new TokenVerificationError()),
}

const accounts: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `jugador-${subject}`, avatarUrl: null }),
}

const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(
      equippedHeroFixture({
        playerId,
        heroId: HERO_PRODUCT_ID,
        reference: 'guerrero-tanque-e2e',
        subtype: 'GUERRERO_TANQUE',
        ready: true,
        blockers: [],
        loadoutVersion: 0,
      }),
    ),
}

describe('HU-29 de extremo a extremo REAL: Combat compromete, Player-Inventory bloquea, Combat libera', () => {
  let piMongoContainer: StartedMongoDBContainer
  let combatMongoContainer: StartedMongoDBContainer
  let combatMongo: MongoClient
  let combatDb: Db
  let catalogMock: { server: Server; baseUrl: string }
  let playerInventory: PlayerInventoryProcess
  let app: INestApplication
  let restoreEnv: () => void
  // Arranca en tiempo real (no una fecha fija del pasado): `expiresAt` del
  // compromiso de batalla (`commitmentExpiresAt(startedAt)`, calculado con
  // ESTE reloj) tiene que ser futuro para el reloj de pared REAL de
  // Player-Inventory en el momento del commit -- Player-Inventory vive en
  // otro proceso y no conoce este reloj de juego.
  const clock = new MutableClock(new Date())

  const http = () => request(app.getHttpServer())
  const auth = () => `Bearer ${COMBAT_TOKEN}`

  const piFetch = async (
    piPath: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${playerInventory.baseUrl}${piPath}`, init)
    const text = await response.text()
    return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
  }

  const getEquipment = (): Promise<{ status: number; body: any }> =>
    piFetch(`/api/inventories/me/heroes/${HERO_PRODUCT_ID}/equipment`)

  const putEquipment = (
    slot: string,
    productReference: string,
  ): Promise<{ status: number; body: any }> =>
    piFetch(`/api/inventories/me/heroes/${HERO_PRODUCT_ID}/equipment/${slot}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productReference }),
    })

  beforeAll(async () => {
    // --- Player-Inventory real: su propio Mongo, su propio proceso ---
    piMongoContainer = await new MongoDBContainer('mongo:8.0').start()
    const piMongoUri = `${piMongoContainer.getConnectionString()}/?directConnection=true`

    catalogMock = await startCatalogMock()
    playerInventory = await startPlayerInventory({
      mongoUri: piMongoUri,
      catalogBaseUrl: catalogMock.baseUrl,
    })

    // Siembra: el jugador "anonymous" posee el heroe y sus tres piezas
    // equipables, via la MISMA ruta HTTP interna que usa Commerce en
    // produccion (`combat` ya esta en su `@InternalCallers`).
    for (const productId of [
      HERO_PRODUCT_ID,
      WEAPON_PRODUCT_ID,
      WEAPON2_PRODUCT_ID,
      ARMOR_PRODUCT_ID,
      ITEM_PRODUCT_ID,
    ]) {
      const grant = await signedInternalPost(
        playerInventory.baseUrl,
        '/api/internal/v1/inventory/grants',
        { operationId: randomUUID(), playerId: PLAYER_ID, items: [{ productId, quantity: 1 }] },
      )

      if (grant.status !== 200) {
        throw new Error(
          `La siembra de ${productId} fallo (${String(grant.status)}): ${JSON.stringify(grant.body)}`,
        )
      }
    }

    // --- Combat real: su propio Mongo, este mismo proceso, HTTP real ---
    combatMongoContainer = await new MongoDBContainer('mongo:8.0').start()
    const combatMongoUri = `${combatMongoContainer.getConnectionString()}/?directConnection=true`
    const combatMongoOptions = { uri: combatMongoUri }

    combatMongo = createCombatMongoClient(combatMongoOptions)
    await combatMongo.connect()
    combatDb = combatDatabaseOf(combatMongo, combatMongoOptions)

    const { error } = await migrateCombatToLatest(combatDb)
    if (error !== undefined) {
      throw new Error(`Las migraciones de Combat fallaron: ${describeError(error)}`)
    }

    const keys = [
      'AUTH_MODE',
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'INTERNAL_SERVICE_AUTH_SECRET',
      'PERSISTENCE_DRIVER',
      'MONGODB_URI',
      'PLAYER_INVENTORY_SERVICE_BASE_URL',
    ]
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      // El MISMO secreto que arranco Player-Inventory: es lo que hace que la
      // firma HMAC real de Combat sea aceptada por el otro proceso real.
      INTERNAL_SERVICE_AUTH_SECRET: INTERNAL_SECRET,
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: combatMongoUri,
      // Sin doble: esto es lo que hace que BATTLE_HERO_COMMITMENTS sea el
      // adaptador HTTP real, apuntando al proceso real que acabamos de
      // levantar (ver app.module.ts, factory de BATTLE_HERO_COMMITMENTS).
      PLAYER_INVENTORY_SERVICE_BASE_URL: playerInventory.baseUrl,
    })

    restoreEnv = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key)
        } else {
          process.env[key] = value
        }
      }
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(accounts)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(heroes)
      // NO se sustituye el PUERTO: es la pieza que esta prueba existe para
      // verificar de verdad. Lo unico que cambia frente a la factory real de
      // app.module.ts es el reloj que firma el HMAC: el reloj de juego de
      // esta prueba es MUTABLE y se adelanta 6 minutos para HU-21/E-10 (sin
      // esperar el tiempo real), pero la firma HMAC la verifica Player-
      // Inventory contra SU reloj de pared real, con una ventana de 30 s
      // (`INTERNAL_CLOCK_SKEW_MS`). Firmar con el reloj de juego adelantado
      // rompería esa firma -- es un problema de mezclar un reloj de dominio
      // acelerable con una firma que, en la realidad, siempre es de tiempo
      // real. La clase es la MISMA (`PlayerInventoryBattleCommitmentHttpClient`,
      // real, sin doblar), construida exactamente igual que en
      // `app.module.ts`, solo con `Date.now()` real para el sello.
      .overrideProvider(BATTLE_HERO_COMMITMENTS)
      .useFactory({
        factory: (logger: Logger) => {
          if (process.env.HU29_E2E_DEBUG === '1') {
            process.stderr.write(
              `[commitments-factory] baseUrl=${playerInventory.baseUrl} secret=${INTERNAL_SECRET}\n`,
            )
          }
          const real = new PlayerInventoryBattleCommitmentHttpClient({
            baseUrl: playerInventory.baseUrl,
            callerService: OUTBOUND_SERVICE_NAME,
            secret: INTERNAL_SECRET,
            clock: { now: () => new Date() } satisfies ClockPort,
            logger,
          })
          return {
            commit: async (command: Parameters<typeof real.commit>[0]) => {
              if (process.env.HU29_E2E_DEBUG === '1') {
                process.stderr.write(
                  `[commitments] commit() called with ${JSON.stringify(command)}\n`,
                )
              }
              try {
                await real.commit(command)
                if (process.env.HU29_E2E_DEBUG === '1') {
                  process.stderr.write(`[commitments] commit() OK\n`)
                }
              } catch (error: unknown) {
                if (process.env.HU29_E2E_DEBUG === '1') {
                  process.stderr.write(
                    `[commitments] commit() FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
                  )
                }
                throw error
              }
            },
            release: async (roomIdArg: string, playerIdArg: string) => {
              if (process.env.HU29_E2E_DEBUG === '1') {
                process.stderr.write(
                  `[commitments] release() called roomId=${roomIdArg} playerId=${playerIdArg}\n`,
                )
              }
              try {
                await real.release(roomIdArg, playerIdArg)
                if (process.env.HU29_E2E_DEBUG === '1') {
                  process.stderr.write(`[commitments] release() OK\n`)
                }
              } catch (error: unknown) {
                if (process.env.HU29_E2E_DEBUG === '1') {
                  process.stderr.write(
                    `[commitments] release() FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
                  )
                }
                throw error
              }
            },
          }
        },
        inject: [LOGGER],
      })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(BATTLE_DEADLINE_SCHEDULER_OPTIONS)
      .useValue({ autoStart: false, tickMs: 1_000 })
      // Sin relacion con HU-29 (HU-22): evita el barrido de fondo del
      // planificador de recompensas, que si no se detiene puede intentar
      // usar Mongo despues de que `afterAll` cierre la conexion.
      .overrideProvider(REWARD_WORKFLOW_SCHEDULER_OPTIONS)
      .useValue({ autoStart: false, tickMs: 1_000, batchSize: 50, reconcileWindowMs: 0 })
      .overrideProvider(REALTIME_GATEWAY_OPTIONS)
      .useValue({ authTimeoutMs: 60_000, heartbeatIntervalMs: 60_000 })
      .compile()

    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  }, 300_000)

  afterAll(async () => {
    if (process.env.HU29_E2E_DEBUG === '1') {
      process.stderr.write(`\n--- Player-Inventory logs ---\n${playerInventory.logs.join('')}\n`)
    }
    await app.close()
    restoreEnv()
    playerInventory.child.kill('SIGTERM')
    catalogMock.server.close()
    await combatMongo.close()
    await combatMongoContainer.stop()
    await piMongoContainer.stop()
  }, 60_000)

  let roomId: string
  let beforeBattleEquipment: unknown

  // E-14 no depende del resto de la narrativa: se verifica aparte y primero.
  it('E-14 — seguridad interna: una llamada sin HMAC al compromiso de batalla se rechaza', async () => {
    const response = await fetch(
      `${playerInventory.baseUrl}/api/internal/v1/inventory/heroes/${HERO_PRODUCT_ID}/battle-commitments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: randomUUID(),
          playerId: PLAYER_ID,
          reference: 'sala-cualquiera',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
    )

    expect(response.status).toBe(401)
  })

  it('E-09 — regla de HU-28 fuera de batalla: un producto no propio sigue siendo 404, no battle_lock', async () => {
    const response = await putEquipment('ITEM_2', randomUUID())

    expect(response.status).toBe(404)
    expect(response.body?.reason).not.toBe('battle_lock')
  })

  it('E-01 — antes de la batalla: equipar arma, armadura e item reales funciona y locked es false', async () => {
    const weapon = await putEquipment('WEAPON_1', WEAPON_PRODUCT_ID)
    expect(weapon.status).toBe(200)
    expect(weapon.body.locked).toBe(false)

    const armor = await putEquipment('HELMET', ARMOR_PRODUCT_ID)
    expect(armor.status).toBe(200)

    const item = await putEquipment('ITEM_1', ITEM_PRODUCT_ID)
    expect(item.status).toBe(200)

    const read = await getEquipment()
    expect(read.status).toBe(200)
    expect(read.body.locked).toBe(false)
    expect(
      read.body.equipment.weapons.map((w: Record<string, unknown>): unknown => w.itemId),
    ).toContain(WEAPON_PRODUCT_ID)
    expect(read.body.equipment.armor.HELMET?.itemId).toBe(ARMOR_PRODUCT_ID)
    expect(
      read.body.equipment.items.map((w: Record<string, unknown>): unknown => w.itemId),
    ).toContain(ITEM_PRODUCT_ID)

    beforeBattleEquipment = read.body
  })

  it('E-00/E-02 — PREPARING: la sala llega a preparada y el equipamiento SIGUE sin bloquear', async () => {
    const created = await http()
      .post('/api/v1/combat/rooms')
      .set('Authorization', auth())
      .send({
        mode: 'PVE',
        teamConfigs: [
          { capacity: 1 },
          { capacity: 1, initialParticipants: [{ kind: 'AI', heroId: 'ai-0' }] },
        ],
        reward: { amount: 0 },
      })

    expect(created.status).toBe(201)
    roomId = created.body.id as string

    const joined = await http()
      .post(`/api/v1/combat/rooms/${roomId}/join`)
      .set('Authorization', auth())
      .send({})

    expect(joined.status).toBe(200)
    expect(joined.body.status).toBe('PREPARING')

    // HU-29: PREPARING no es "iniciado el combate" -- el guard de Player-Inventory
    // todavia no debe haberse disparado, porque Combat todavia no ha comprometido nada.
    const stillUnlocked = await getEquipment()
    expect(stillUnlocked.status).toBe(200)
    expect(stillUnlocked.body.locked).toBe(false)
  })

  it('E-03 — inicio real: StartBattle compromete contra Player-Inventory real y GET equipment pasa a locked:true', async () => {
    const started = await http()
      .post(`/api/v1/combat/rooms/${roomId}/start`)
      .set('Authorization', auth())

    if (process.env.HU29_E2E_DEBUG === '1' && started.status !== 200) {
      process.stderr.write(
        `[E-03 debug] status=${String(started.status)} body=${JSON.stringify(started.body)}\n`,
      )
    }

    expect(started.status).toBe(200)
    expect(started.body.status).toBe('IN_BATTLE')

    const read = await getEquipment()
    expect(read.status).toBe(200)
    expect(read.body.locked).toBe(true)
  })

  it('E-04 — arma bloqueada durante la batalla: 409 reason=battle_lock, equipo intacto', async () => {
    const attempt = await putEquipment('WEAPON_2', WEAPON2_PRODUCT_ID)

    expect(attempt.status).toBe(409)
    expect(attempt.body.reason).toBe('battle_lock')
    expect(typeof attempt.body.message).toBe('string')
    expect(attempt.body.message.length).toBeGreaterThan(0)
  })

  it('E-05 — armadura bloqueada durante la batalla', async () => {
    const attempt = await putEquipment('CHEST', ARMOR_PRODUCT_ID)

    expect(attempt.status).toBe(409)
    expect(attempt.body.reason).toBe('battle_lock')
  })

  it('E-06 — item bloqueado durante la batalla', async () => {
    const attempt = await putEquipment('ITEM_2', ITEM_PRODUCT_ID)

    expect(attempt.status).toBe(409)
    expect(attempt.body.reason).toBe('battle_lock')
  })

  it('E-07/E-08 — repeticion y autoridad servidor: dos intentos seguidos, cero cambio acumulado, aunque el cliente insista', async () => {
    const first = await putEquipment('WEAPON_2', WEAPON2_PRODUCT_ID)
    const second = await putEquipment('WEAPON_2', WEAPON2_PRODUCT_ID)

    expect(first.status).toBe(409)
    expect(second.status).toBe(409)

    const after = await getEquipment()
    expect(after.status).toBe(200)
    expect(after.body.locked).toBe(true)
  })

  it('E-12 — integridad del loadout: el equipo durante la batalla es IDENTICO al de antes de iniciarla, salvo locked', async () => {
    const during = await getEquipment()

    const { locked: lockedBefore, ...restBefore } = beforeBattleEquipment as Record<string, unknown>
    const { locked: lockedDuring, ...restDuring } = during.body

    expect(lockedBefore).toBe(false)
    expect(lockedDuring).toBe(true)
    expect(restDuring).toEqual(restBefore)
  })

  it('E-10 — fin real: el vencimiento global via ProcessBattleDeadlines libera el compromiso y locked vuelve a false', async () => {
    // Mismo mecanismo real que HU-21: avanzar el reloj mas alla del temporizador
    // global (6 minutos) y pedirle al caso de uso real que liquide la sala vencida.
    clock.advance(6 * 60_000 + 1)

    const deadlines = app.get<ProcessBattleDeadlines>(PROCESS_BATTLE_DEADLINES)
    await deadlines.execute(roomId)

    const read = await http().get(`/api/v1/combat/rooms/${roomId}`).set('Authorization', auth())
    expect(read.body.status).toBe('FINISHED')

    // BattleFinalizer libera en segundo plano (fire-and-forget, ver auditoria):
    // se espera a que Player-Inventory refleje la liberacion.
    const deadline = Date.now() + 10_000
    let unlocked = false
    while (Date.now() < deadline) {
      const equipment = await getEquipment()
      if (equipment.body.locked === false) {
        unlocked = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    expect(unlocked).toBe(true)
  })

  it('E-11 — tras liberar, el MISMO cambio antes rechazado ahora lo acepta HU-28', async () => {
    if (process.env.HU29_E2E_DEBUG === '1') {
      const pre = await getEquipment()
      process.stderr.write(`[E-11 debug] GET before retry: locked=${String(pre.body?.locked)}\n`)
    }
    const retry = await putEquipment('WEAPON_2', WEAPON2_PRODUCT_ID)
    if (process.env.HU29_E2E_DEBUG === '1' && retry.status !== 200) {
      process.stderr.write(
        `[E-11 debug] PUT status=${String(retry.status)} body=${JSON.stringify(retry.body)}\n`,
      )
    }

    expect(retry.status).toBe(200)
    expect(retry.body.locked).toBe(false)
    expect(
      retry.body.equipment.weapons.map((w: Record<string, unknown>): unknown => w.itemId),
    ).toContain(WEAPON2_PRODUCT_ID)
  })

  it('E-13 — idempotencia del release: reconciliar de nuevo no da error ni cambia el estado ya liberado', async () => {
    const reconcile = app.get<ReconcileRewardWorkflows>(RECONCILE_REWARD_WORKFLOWS)

    await expect(reconcile.execute(new Date(clock.now().getTime() - 60_000))).resolves.not.toThrow()

    const read = await getEquipment()
    expect(read.status).toBe(200)
    expect(read.body.locked).toBe(false)
  })
})
