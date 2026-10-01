/* eslint-disable @typescript-eslint/no-explicit-any -- las respuestas HTTP/documentos Mongo de los servicios reales son JSON dinamico; el contrato se verifica con las aserciones, no con tipos */
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
import { MongoClient, type Db } from 'mongodb'
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
  BATTLE_RANDOM_SEQUENCE,
  EXECUTE_BASIC_ATTACK,
  REWARD_WORKFLOW_SCHEDULER_OPTIONS,
} from '../../../src/adapters/inbound/http/tokens'
import type { ExecuteBasicAttack } from '../../../src/application/use-cases/ExecuteBasicAttack'
import { RandomIndex } from '../../../src/domain/value-objects/RandomIndex'
import { RandomEffectType } from '../../../src/domain/random-effects/RandomEffectType'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../../src/application/ports/TokenVerifierPort'
import { REALTIME_GATEWAY_OPTIONS } from '../../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import { CLOCK, type ClockPort } from '../../../src/application/ports/ClockPort'
import { BATTLE_HERO_COMMITMENTS } from '../../../src/application/ports/BattleHeroCommitmentPort'
import { BATTLE_DROP_INVENTORY } from '../../../src/application/ports/BattleDropInventoryPort'
import { BATTLE_DROP_NOTIFIER } from '../../../src/application/ports/BattleDropNotificationPort'
import { PlayerInventoryBattleCommitmentHttpClient } from '../../../src/adapters/outbound/http/PlayerInventoryBattleCommitmentHttpClient'
import { PlayerInventoryBattleDropHttpClient } from '../../../src/adapters/outbound/http/PlayerInventoryBattleDropHttpClient'
import { NotificationsBattleDropHttpClient } from '../../../src/adapters/outbound/http/NotificationsBattleDropHttpClient'
import { IntervalBattleDropScheduler } from '../../../src/adapters/outbound/system/IntervalBattleDropScheduler'
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
import { indexForEffect, indexForFace } from '../../fixtures/basic-attack'

/**
 * HU-30 de extremo a extremo, REAL: Combat real (este proceso, HTTP real) ->
 * HMAC real -> Player-Inventory real (proceso Node aparte, su build de
 * verdad) Y Notifications real (otro proceso Node aparte, su build de
 * verdad) -> MongoDB real, UN CONTENEDOR POR SERVICIO (ADR-001). Mismo patron
 * que `test/e2e/hu-29/equipment-lock.e2e.spec.ts`; ver `jest.e2e-hu30.config.ts`
 * para por que esto vive fuera de `test:db`/CI.
 *
 * REAL en esta prueba: `StartBattle` capturando la instantanea de drop contra
 * Player-Inventory real; la resolucion del drop (RNG central, HU-24) dentro
 * de `ExecuteBasicAttack`/`PersistVersusDropDecision`; `IntervalBattleDropScheduler`
 * liquidando contra Player-Inventory real DESPUES de `FINISHED`, nunca antes;
 * la transferencia de la MISMA instancia fisica en Player-Inventory (Mongo
 * real, transaccion real); la notificacion HTTP+HMAC real a Notifications
 * real tras cada acreditacion; y la liberacion del compromiso HU-29 de ambos
 * jugadores.
 *
 * SUSTITUIDO, declarado explicitamente, por ser ajeno a HU-30 e
 * imprescindible solo para construir el fixture (mismo criterio que HU-29):
 * - `ACCOUNT_BATTLE_PROFILE`, `PLAYER_INVENTORY_EQUIPPED_HERO` y
 *   `TOKEN_VERIFIER` de Combat.
 * - El propio `CatalogReadPort` de Player-Inventory (doble HTTP minimo, igual
 *   que en HU-29, ahora con `dropChanceBasisPoints` en los productos
 *   equipables).
 * - El RELOJ que firma el HMAC saliente de Combat hacia Player-Inventory
 *   (mismo motivo documentado en HU-29: el reloj de juego se adelanta para
 *   HU-21 y romperia la ventana de 30 s de la firma real).
 * - `BATTLE_RANDOM_SEQUENCE` (HU-24): el MISMO patron que ya usan
 *   `test/db/basic-attack.e2e.spec.ts`/`skills.e2e.spec.ts` de este repo --
 *   una secuencia guionizada que fija el dado del ataque basico para que
 *   acierte y mate de forma deterministica. El consumo de HU-30 (dos indices
 *   por candidato, evaluacion individual, seleccion) es el codigo real; solo
 *   el VALOR del dado esta fijado, y la tasa de caida (0 % o 100 % en el
 *   producto de Catalog) hace que la elegibilidad no dependa de ese valor.
 * - El transporte WebSocket de HU-18 (`BasicAttackRealtimeHandler`): ajeno a
 *   HU-30. Esta prueba invoca `ExecuteBasicAttack` -el mismo caso de uso que
 *   el gateway real- directamente desde el contenedor de Nest, en vez de
 *   replicar el protocolo de tickets/WebSocket solo para disparar un ataque.
 */

// PLAYER_B es 'anonymous' a proposito: Player-Inventory arranca con
// AUTH_MODE=disabled (igual que HU-29) y su `AnonymousIdentityGuard`
// atribuye TODA peticion publica (`/api/inventories/me/...`) a ese sujeto
// fijo, sea cual sea el testimonio. Por eso solo B -el derrotado, cuyo
// equipamiento real hace falta equipar via la ruta publica- usa ese sujeto;
// A -el killer, que nunca llama a la API publica de Player-Inventory- puede
// ser cualquier identificador propio, porque Combat lo pasa explicito en
// cada llamada interna firmada (`playerId`/`targetPlayerId`), que Player-
// Inventory confia por venir de un caller HMAC autorizado, no por sesion.
const PLAYER_A = 'jugador-a-e2e-hu30'
const PLAYER_B = 'anonymous'
const TOKEN_A = 'token-jugador-a'
const TOKEN_B = 'token-jugador-b'
const INTERNAL_SECRET = 'secreto-e2e-hu-30'

const HERO_A_PRODUCT_ID = randomUUID()
const HERO_B_PRODUCT_ID = randomUUID()
// HU-28 real: `EquipItemOnHero` rechaza equipar sobre una ranura YA ocupada
// (no la reemplaza en silencio) -- un segundo heroe fresco para B evita ese
// 409 real entre escenarios sin inventar una operacion de desequipar ajena a
// HU-30.
const HERO_B2_PRODUCT_ID = randomUUID()
const WEAPON_NO_DROP_PRODUCT_ID = randomUUID()
const WEAPON_GUARANTEED_PRODUCT_ID = randomUUID()

const PI_REPO_PATH =
  process.env.PLAYER_INVENTORY_REPO_PATH ??
  path.resolve(__dirname, '../../../../../Player-Inventory/Nexus-Battle-Player-Inventory')
const NOTIFICATIONS_REPO_PATH =
  process.env.NOTIFICATIONS_REPO_PATH ??
  path.resolve(__dirname, '../../../../../Notifications/Nexus-Battle-Notifications')

// -----------------------------------------------------------------------
// Fixtures de Catalog v1. `dropChanceBasisPoints` es el campo de HU-30: 0
// nunca es elegible, 10000 siempre lo es, sin depender del dado.
// -----------------------------------------------------------------------
const heroAttributes = (subtype: string) => ({
  schemaVersion: '1',
  values: {
    kind: 'HEROE',
    heroSubtype: subtype,
    basePower: 5,
    baseHealth: 1,
    baseDefense: 8,
    baseAttack: { mode: 'FIXED', amount: 50 },
    abilities: [],
  },
})

const weaponAttributes = (dropChanceBasisPoints: number) => ({
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
    dropChanceBasisPoints,
  },
})

const catalogProducts: Record<string, unknown> = {
  [HERO_A_PRODUCT_ID]: {
    productId: HERO_A_PRODUCT_ID,
    sku: 'guerrero-a-e2e-hu30',
    name: 'Guerrero A (E2E HU-30)',
    imageUrl: 'https://assets.example.test/guerrero-a.png',
    description: 'Heroe killer de la prueba de extremo a extremo de HU-30.',
    type: 'HEROE',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 0,
    premium: false,
    realMoneyPrice: null,
    attributes: heroAttributes('GUERRERO_ARMAS'),
  },
  [HERO_B_PRODUCT_ID]: {
    productId: HERO_B_PRODUCT_ID,
    sku: 'guerrero-b-e2e-hu30',
    name: 'Guerrero B (E2E HU-30)',
    imageUrl: 'https://assets.example.test/guerrero-b.png',
    description: 'Heroe derrotado de la prueba de extremo a extremo de HU-30.',
    type: 'HEROE',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 0,
    premium: false,
    realMoneyPrice: null,
    attributes: heroAttributes('GUERRERO_ARMAS'),
  },
  [HERO_B2_PRODUCT_ID]: {
    productId: HERO_B2_PRODUCT_ID,
    sku: 'guerrero-b2-e2e-hu30',
    name: 'Guerrero B2 (E2E HU-30)',
    imageUrl: 'https://assets.example.test/guerrero-b2.png',
    description: 'Segundo heroe derrotado (escenario E-02) de la prueba de extremo a extremo de HU-30.',
    type: 'HEROE',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 0,
    premium: false,
    realMoneyPrice: null,
    attributes: heroAttributes('GUERRERO_ARMAS'),
  },
  [WEAPON_NO_DROP_PRODUCT_ID]: {
    productId: WEAPON_NO_DROP_PRODUCT_ID,
    sku: 'espada-sin-tasa-e2e-hu30',
    name: 'Espada sin tasa (E2E HU-30)',
    imageUrl: 'https://assets.example.test/espada-sin-tasa.png',
    description: 'Arma con 0% de probabilidad de caida.',
    type: 'ARMA',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 10,
    premium: false,
    realMoneyPrice: null,
    attributes: weaponAttributes(0),
  },
  [WEAPON_GUARANTEED_PRODUCT_ID]: {
    productId: WEAPON_GUARANTEED_PRODUCT_ID,
    sku: 'espada-garantizada-e2e-hu30',
    name: 'Espada garantizada (E2E HU-30)',
    imageUrl: 'https://assets.example.test/espada-garantizada.png',
    description: 'Arma con 100% de probabilidad de caida.',
    type: 'ARMA',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 10,
    premium: false,
    realMoneyPrice: null,
    attributes: weaponAttributes(10_000),
  },
}

const startCatalogMock = async (): Promise<{ server: Server; baseUrl: string }> => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = /^\/api\/v1\/catalog\/products\/([^/]+)$/u.exec(url.pathname)

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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('El doble de Catalog no pudo resolver su puerto.')
  }

  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` }
}

// -----------------------------------------------------------------------
// Player-Inventory y Notifications reales: build de produccion + proceso
// Node aparte, mismo patron que HU-29.
// -----------------------------------------------------------------------
const waitForHealth = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Todavia no escucha: se reintenta hasta el plazo.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  throw new Error(`El servicio no respondio sano en ${String(timeoutMs)} ms (${url}).`)
}

const runToCompletion = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): void => {
  try {
    execFileSync(command, args, { cwd, env, encoding: 'utf8', shell: process.platform === 'win32' })
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error(
      `Comando "${command} ${args.join(' ')}" fallo en ${cwd}.\n` +
        `stdout:\n${execError.stdout ?? ''}\nstderr:\n${execError.stderr ?? execError.message ?? String(error)}`,
      { cause: error },
    )
  }
}

interface SiblingProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly baseUrl: string
  readonly logs: string[]
}

const startPlayerInventory = async (options: {
  readonly mongoUri: string
  readonly catalogBaseUrl: string
}): Promise<SiblingProcess> => {
  if (!fs.existsSync(PI_REPO_PATH)) {
    throw new Error(
      `No se encontro Nexus-Battle-Player-Inventory en "${PI_REPO_PATH}". Este spec necesita ` +
        'el repo hermano en el mismo checkout multirepo (o PLAYER_INVENTORY_REPO_PATH).',
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

  runToCompletion('npm', ['run', 'build'], sharedEnv, PI_REPO_PATH)
  runToCompletion('node', ['dist/infrastructure/persistence/migrate.js'], sharedEnv, PI_REPO_PATH)

  const port = 21_000 + Math.floor(Math.random() * 4_000)
  const env: NodeJS.ProcessEnv = { ...sharedEnv, PORT: String(port) }
  const child = spawn('node', ['dist/main.js'], { cwd: PI_REPO_PATH, env })
  const logs: string[] = []
  child.stdout.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')))
  child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')))

  const baseUrl = `http://127.0.0.1:${String(port)}`

  try {
    await waitForHealth(`${baseUrl}/api/health/live`, 60_000)
  } catch (error: unknown) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nSalida de Player-Inventory:\n${logs.join('')}`,
      { cause: error },
    )
  }

  return { child, baseUrl, logs }
}

const startNotifications = async (options: {
  readonly mongoUri: string
}): Promise<SiblingProcess & { readonly dropPort: number }> => {
  if (!fs.existsSync(NOTIFICATIONS_REPO_PATH)) {
    throw new Error(
      `No se encontro Nexus-Battle-Notifications en "${NOTIFICATIONS_REPO_PATH}". Este spec ` +
        'necesita el repo hermano en el mismo checkout multirepo (o NOTIFICATIONS_REPO_PATH).',
    )
  }

  const healthPort = 25_000 + Math.floor(Math.random() * 1_000)
  const catalogNotificationsPort = healthPort + 1_000
  const dropPort = healthPort + 2_000

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    HEALTH_PORT: String(healthPort),
    INTERNAL_SERVICE_AUTH_SECRET: INTERNAL_SECRET,
    MONGO_URL: options.mongoUri,
    MONGO_DB_NAME: 'notifications-e2e-hu30',
    // Subsistemas ajenos a HU-30, apagados a proposito (igual que local sin AWS).
    PURCHASE_HTTP_ENABLED: 'false',
    QUEUE_DRIVER: 'memory',
    EMAIL_DRIVER: 'fake',
    CATALOG_QUEUE_DRIVER: 'memory',
    // Requeridos por config aunque este servidor no verifica JWT real: el
    // servidor HMAC de HU-30 (`createAuctionOutbidServer`) no pasa por aqui.
    COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
    COGNITO_CLIENT_ID: 'cliente-de-pruebas',
    CATALOG_NOTIFICATIONS_HTTP_ENABLED: 'true',
    CATALOG_NOTIFICATIONS_HTTP_PORT: String(catalogNotificationsPort),
    CATALOG_NOTIFICATIONS_REPOSITORY_DRIVER: 'mongo',
    AUCTION_OUTBID_HTTP_ENABLED: 'true',
    AUCTION_OUTBID_HTTP_PORT: String(dropPort),
    PLAYER_INVENTORY_BASE_URL: 'http://127.0.0.1:1',
  }

  runToCompletion('npm', ['run', 'build'], env, NOTIFICATIONS_REPO_PATH)

  const child = spawn('node', ['dist/worker.js'], { cwd: NOTIFICATIONS_REPO_PATH, env })
  const logs: string[] = []
  child.stdout.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')))
  child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')))

  const baseUrl = `http://127.0.0.1:${String(dropPort)}`

  try {
    await waitForHealth(`http://127.0.0.1:${String(healthPort)}/health/live`, 60_000)
  } catch (error: unknown) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nSalida de Notifications:\n${logs.join('')}`,
      { cause: error },
    )
  }

  return { child, baseUrl, logs, dropPort }
}

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

const verifier: TokenVerifierPort = {
  verify: (token) => {
    if (token === TOKEN_A) {
      return Promise.resolve({ subject: PLAYER_A, email: null, roles: new Set([Role.Player]) })
    }
    if (token === TOKEN_B) {
      return Promise.resolve({ subject: PLAYER_B, email: null, roles: new Set([Role.Player]) })
    }
    return Promise.reject(new TokenVerificationError())
  },
}

const accounts: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `nombre-de-${subject}`, avatarUrl: null }),
}

// HU-30: `StartBattle` pasa `hero.loadoutVersion` a `CaptureBattleDropSnapshot`
// de Player-Inventory real, que lo compara contra la version REAL del
// loadout -- a diferencia de HU-29, que solo usa este campo para el
// compromiso y nunca lo valida contra el estado real. B equipa de verdad
// (via la ruta publica, bajo su identidad fija `anonymous`) antes de cada
// escenario, asi que el doble lleva la cuenta de cuantas veces se equipo
// para reportar la MISMA version que Player-Inventory tiene en ese momento,
// en vez de inventar un 0 fijo que rompería esa comprobacion real.
let loadoutVersionForB = 0
// E-02 usa un heroe fresco para B (ver `HERO_B2_PRODUCT_ID`): equipar sobre
// una ranura ya ocupada es un 409 REAL de HU-28 (no un reemplazo silencioso).
let currentHeroIdForB = HERO_B_PRODUCT_ID

// Vida de B fijada en 1: `equippedHeroFixture()` por defecto da 40 (la misma
// constante para cualquier heroe), y HU-30 no necesita simular un combate
// largo -- solo UN golpe real que lo derrote, para disparar el evento letal
// real del que depende `PersistVersusDropDecision`. Cualquier dano positivo
// basta, asi que el valor exacto del dado guionizado no importa.
const oneHitPointStats = {
  power: 8,
  health: 1,
  defense: 8,
  attack: 10,
  damage: { mode: 'DICE', count: 1, sides: 4 } as const,
  healing: null,
}

const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(
      equippedHeroFixture({
        playerId,
        heroId: playerId === PLAYER_A ? HERO_A_PRODUCT_ID : currentHeroIdForB,
        reference: playerId === PLAYER_A ? 'guerrero-a-e2e-hu30' : 'guerrero-b-e2e-hu30',
        subtype: 'GUERRERO_ARMAS',
        ready: true,
        blockers: [],
        loadoutVersion: playerId === PLAYER_A ? 0 : loadoutVersionForB,
        ...(playerId === PLAYER_B
          ? { baseStats: oneHitPointStats, effectiveStats: { ...oneHitPointStats, attack: 13 } }
          : {}),
      }),
    ),
}

describe('HU-30 de extremo a extremo REAL: Combat resuelve el drop, Player-Inventory lo liquida, Notifications avisa', () => {
  let piMongoContainer: StartedMongoDBContainer
  let notificationsMongoContainer: StartedMongoDBContainer
  let combatMongoContainer: StartedMongoDBContainer
  let combatMongo: MongoClient
  let combatDb: Db
  let piMongo: MongoClient
  let piDb: Db
  let notificationsMongo: MongoClient
  let notificationsDb: Db
  let catalogMock: { server: Server; baseUrl: string }
  let playerInventory: SiblingProcess
  let notifications: SiblingProcess & { readonly dropPort: number }
  let app: INestApplication
  let restoreEnv: () => void
  const clock = new MutableClock(new Date())

  // HU-24 real (MT19937), pero con una cola RELLENABLE: a diferencia de
  // `scriptedSequence` (fija, se agota), esta prueba dispara varios ataques
  // en `it()`s separados y necesita encolar valores justo antes de cada uno.
  // La evaluacion de HU-30 (consumo de 2 indices, elegibilidad, seleccion)
  // sigue siendo el codigo real; solo el VALOR del dado se fija para que el
  // golpe acierte y la caida sea deterministica.
  const randomQueue: number[] = []
  const sequence = {
    nextIndex: () => {
      const value = randomQueue.shift()
      if (value === undefined) throw new Error('randomQueue agotada en el E2E de HU-30.')
      return RandomIndex.create(value)
    },
  }
  const queueLethalBasicAttack = (): void => {
    randomQueue.push(
      indexForFace(5, 6),
      indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
      indexForFace(4, 6),
      1,
      1,
    )
  }

  const http = () => request(app.getHttpServer())
  const authAs = (subject: string) => `Bearer ${subject === PLAYER_A ? TOKEN_A : TOKEN_B}`

  beforeAll(async () => {
    piMongoContainer = await new MongoDBContainer('mongo:8.0').start()
    const piMongoUri = `${piMongoContainer.getConnectionString()}/?directConnection=true`

    notificationsMongoContainer = await new MongoDBContainer('mongo:8.0').start()
    const notificationsMongoUri = `${notificationsMongoContainer.getConnectionString()}/?directConnection=true`

    catalogMock = await startCatalogMock()
    ;[playerInventory, notifications] = await Promise.all([
      startPlayerInventory({ mongoUri: piMongoUri, catalogBaseUrl: catalogMock.baseUrl }),
      startNotifications({ mongoUri: notificationsMongoUri }),
    ])

    piMongo = new MongoClient(piMongoUri)
    await piMongo.connect()
    piDb = piMongo.db('player-inventory')

    notificationsMongo = new MongoClient(notificationsMongoUri)
    await notificationsMongo.connect()
    notificationsDb = notificationsMongo.db('notifications-e2e-hu30')

    // Siembra: ambos jugadores poseen su heroe; B ademas posee las dos armas
    // (una por escenario) para poder equiparlas.
    for (const [playerId, productIds] of [
      [PLAYER_A, [HERO_A_PRODUCT_ID]],
      [
        PLAYER_B,
        [HERO_B_PRODUCT_ID, HERO_B2_PRODUCT_ID, WEAPON_NO_DROP_PRODUCT_ID, WEAPON_GUARANTEED_PRODUCT_ID],
      ],
    ] as const) {
      for (const productId of productIds) {
        const grant = await signedInternalPost(
          playerInventory.baseUrl,
          '/api/internal/v1/inventory/grants',
          { operationId: randomUUID(), playerId, items: [{ productId, quantity: 1 }] },
        )
        if (grant.status !== 200) {
          throw new Error(
            `La siembra de ${productId} para ${playerId} fallo (${String(grant.status)}): ${JSON.stringify(grant.body)}`,
          )
        }
      }
    }

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
      'NOTIFICATIONS_SERVICE_BASE_URL',
    ]
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: INTERNAL_SECRET,
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: combatMongoUri,
      PLAYER_INVENTORY_SERVICE_BASE_URL: playerInventory.baseUrl,
      NOTIFICATIONS_SERVICE_BASE_URL: notifications.baseUrl,
    })

    restoreEnv = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(accounts)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(heroes)
      // Mismo motivo que HU-29: el cliente REAL de compromisos, pero con un
      // reloj de pared real para el sello HMAC, independiente del reloj de
      // juego (avanzable) de esta prueba.
      .overrideProvider(BATTLE_HERO_COMMITMENTS)
      .useFactory({
        factory: (logger: Logger) =>
          new PlayerInventoryBattleCommitmentHttpClient({
            baseUrl: playerInventory.baseUrl,
            callerService: OUTBOUND_SERVICE_NAME,
            secret: INTERNAL_SECRET,
            clock: { now: () => new Date() } satisfies ClockPort,
            logger,
          }),
        inject: [LOGGER],
      })
      // HU-30: mismo criterio -- el cliente REAL de drops de Player-Inventory,
      // con el MISMO reloj de pared real para la firma saliente.
      .overrideProvider(BATTLE_DROP_INVENTORY)
      .useFactory({
        factory: (logger: Logger) =>
          new PlayerInventoryBattleDropHttpClient({
            baseUrl: playerInventory.baseUrl,
            callerService: OUTBOUND_SERVICE_NAME,
            secret: INTERNAL_SECRET,
            clock: { now: () => new Date() } satisfies ClockPort,
            logger,
          }),
        inject: [LOGGER],
      })
      .overrideProvider(BATTLE_DROP_NOTIFIER)
      .useFactory({
        factory: (logger: Logger) =>
          new NotificationsBattleDropHttpClient({
            baseUrl: notifications.baseUrl,
            callerService: OUTBOUND_SERVICE_NAME,
            secret: INTERNAL_SECRET,
            clock: { now: () => new Date() } satisfies ClockPort,
            logger,
          }),
        inject: [LOGGER],
      })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(BATTLE_RANDOM_SEQUENCE)
      .useValue(sequence)
      .overrideProvider(BATTLE_DEADLINE_SCHEDULER_OPTIONS)
      .useValue({ autoStart: false, tickMs: 1_000 })
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
    await app.close()
    restoreEnv()
    playerInventory.child.kill('SIGTERM')
    notifications.child.kill('SIGTERM')
    catalogMock.server.close()
    await combatMongo.close()
    await piMongo.close()
    await notificationsMongo.close()
    await combatMongoContainer.stop()
    await piMongoContainer.stop()
    await notificationsMongoContainer.stop()
  }, 60_000)

  /** Crea y arranca una sala 1v1 real entre A (killer) y B (derrotado), devuelve su id. */
  const createAndStartRoom = async (): Promise<string> => {
    // Ambos equipos vacios al crear (mismo patron probado que HU-29): el
    // creador NO se sienta solo por crear la sala, se sienta con su propio
    // `join`, igual que el segundo jugador.
    const created = await http()
      .post('/api/v1/combat/rooms')
      .set('Authorization', authAs(PLAYER_A))
      .send({
        mode: 'PVP',
        teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
        reward: { amount: 0 },
      })
    expect(created.status).toBe(201)
    const roomId = created.body.id as string

    const joinedA = await http()
      .post(`/api/v1/combat/rooms/${roomId}/join`)
      .set('Authorization', authAs(PLAYER_A))
      .send({})
    expect(joinedA.status).toBe(200)

    const joinedB = await http()
      .post(`/api/v1/combat/rooms/${roomId}/join`)
      .set('Authorization', authAs(PLAYER_B))
      .send({})
    expect(joinedB.status).toBe(200)
    expect(joinedB.body.status).toBe('PREPARING')

    // `StartBattle` consume UN indice real (HU-17) para decidir el equipo
    // inicial antes de intercalar la cola de turnos; en 1v1 barajar un unico
    // integrante por equipo no consume ninguno mas (Fisher-Yates no gira
    // sobre un solo elemento).
    randomQueue.push(1)
    const started = await http()
      .post(`/api/v1/combat/rooms/${roomId}/start`)
      .set('Authorization', authAs(PLAYER_A))
    expect(started.status).toBe(200)
    expect(started.body.status).toBe('IN_BATTLE')

    return roomId
  }

  /**
   * A (killer) ataca a B (derrotado, Vida base 1): basta un golpe real para
   * matarlo, y en un 1v1 eso agota al equipo B y termina la partida de
   * inmediato -- el MISMO evento letal que dispara `PersistVersusDropDecision`
   * real. Se invoca `ExecuteBasicAttack` directamente (ver nota de cabecera
   * sobre el transporte WebSocket sustituido).
   */
  /**
   * `BattleFinalizer.afterFinished()` libera el compromiso HU-29 en
   * fire-and-forget (deliberado: la sala ya esta persistida como FINISHED y
   * no debe esperar una llamada HTTP lenta). Se sondea en vez de asumir que
   * ya termino -- mismo criterio que E-10 de `test/e2e/hu-29`.
   */
  const waitForCommitmentReleased = async (playerId: string, roomId: string): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const commitment = await piDb
        .collection('battle-hero-commitments')
        .findOne({ playerId, reference: roomId })
      if (commitment?.status === 'RELEASED') return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`El compromiso de ${playerId} en ${roomId} no se libero a tiempo.`)
  }

  const killDefenderAndFinish = async (roomId: string): Promise<void> => {
    queueLethalBasicAttack()
    const attack = app.get<ExecuteBasicAttack>(EXECUTE_BASIC_ATTACK)
    const result = await attack.execute({
      roomId,
      requesterId: PLAYER_A,
      commandId: randomUUID(),
      target: { teamLabel: 'B', seat: 0 },
    })

    expect(result.finished?.status).toBe('FINISHED')
  }

  describe('E-01 — sin drop (0%): ningun pendiente, cero transferencias, ownership intacto', () => {
    let roomId: string

    it('equipa el arma sin tasa, inicia y termina la batalla; B sigue siendo el propietario', async () => {
      // Ruta publica bajo AUTH_MODE=disabled (`AnonymousIdentityGuard`): no
      // hace falta sesion real para equipar en la siembra del fixture, igual
      // que HU-29. B ya posee el producto desde la siembra inicial.
      const put = await fetch(
        `${playerInventory.baseUrl}/api/inventories/me/heroes/${HERO_B_PRODUCT_ID}/equipment/WEAPON_1`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ productReference: WEAPON_NO_DROP_PRODUCT_ID }),
        },
      )
      expect(put.status).toBe(200)
      loadoutVersionForB += 1

      roomId = await createAndStartRoom()
      await killDefenderAndFinish(roomId)

      const scheduler = app.get(IntervalBattleDropScheduler)
      await scheduler.tick()

      const workflows = await combatDb
        .collection('battle-drop-workflows')
        .find({ battleId: roomId })
        .toArray()
      expect(workflows).toHaveLength(1)
      expect(workflows[0]?.state).toBe('NO_DROP')
      expect(workflows[0]?.defeatedPlayerId).toBe(PLAYER_B)
      expect(workflows[0]?.killerPlayerId).toBe(PLAYER_A)

      const unit = await piDb
        .collection('battle-drop-units')
        .findOne({ ownerId: PLAYER_B, itemId: WEAPON_NO_DROP_PRODUCT_ID })
      // Sin drop: la unidad sigue siendo de B (si llego a materializarse) o
      // nunca se materializo; en ningun caso cambia de dueño.
      if (unit !== null) expect(unit.ownerId).toBe(PLAYER_B)

      const notification = await notificationsDb
        .collection('catalog_notifications')
        .findOne({ sourceEventId: new RegExp(`^${roomId}:`) })
      expect(notification).toBeNull()

      await waitForCommitmentReleased(PLAYER_A, roomId)
      await waitForCommitmentReleased(PLAYER_B, roomId)
    })
  })

  describe('E-02 — con drop (100%): pendiente durante la partida, acreditado solo tras FINISHED, idempotente', () => {
    let roomId: string

    it('equipa el arma garantizada e inicia: durante la partida B SIGUE siendo propietario', async () => {
      // Heroe FRESCO para este escenario: equipar sobre una ranura ya
      // ocupada (la de E-01) es un 409 real de HU-28, no un reemplazo
      // silencioso -- no es parte de HU-30 reabrir esa semantica.
      currentHeroIdForB = HERO_B2_PRODUCT_ID
      loadoutVersionForB = 0

      const put = await fetch(
        `${playerInventory.baseUrl}/api/inventories/me/heroes/${HERO_B2_PRODUCT_ID}/equipment/WEAPON_1`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ productReference: WEAPON_GUARANTEED_PRODUCT_ID }),
        },
      )
      expect(put.status).toBe(200)
      loadoutVersionForB += 1

      roomId = await createAndStartRoom()

      // `StartBattle` ya capturo la instantanea REAL contra Player-Inventory:
      // la unidad queda identificada y RESERVADA para esta sala (`battleId`),
      // pero el ownership NO cambia todavia -- sigue siendo de B.
      const unitDuring = await piDb
        .collection('battle-drop-units')
        .findOne({ itemId: WEAPON_GUARANTEED_PRODUCT_ID, ownerId: PLAYER_B })
      expect(unitDuring).not.toBeNull()
      expect(unitDuring?.battleId).toBe(roomId)

      await killDefenderAndFinish(roomId)

      const scheduler = app.get(IntervalBattleDropScheduler)
      await scheduler.tick()

      const workflows = await combatDb
        .collection('battle-drop-workflows')
        .find({ battleId: roomId })
        .toArray()
      expect(workflows).toHaveLength(1)
      expect(workflows[0]?.state).toBe('CREDITED')
      expect(workflows[0]?.receipt?.sourcePlayerId).toBe(PLAYER_B)
      expect(workflows[0]?.receipt?.targetPlayerId).toBe(PLAYER_A)
      const productInstanceId = workflows[0]?.receipt?.productInstanceId as string
      expect(productInstanceId).toEqual(expect.any(String))

      // Ownership REAL en Player-Inventory: la MISMA instancia cambio de dueño.
      const unitAfter = await piDb
        .collection<any>('battle-drop-units')
        .findOne({ _id: productInstanceId })
      expect(unitAfter?.ownerId).toBe(PLAYER_A)
      expect(unitAfter?.battleId).toBe('')

      const inventoryOfA = await piDb.collection<any>('inventories').findOne({ _id: PLAYER_A })
      const slotOfA = (inventoryOfA?.slots as any[]).find(
        (s) => s.itemId === WEAPON_GUARANTEED_PRODUCT_ID,
      )
      expect(slotOfA?.quantity).toBe(1)

      const inventoryOfB = await piDb.collection<any>('inventories').findOne({ _id: PLAYER_B })
      const slotOfB = (inventoryOfB?.slots as any[] | undefined)?.find(
        (s) => s.itemId === WEAPON_GUARANTEED_PRODUCT_ID,
      )
      expect(slotOfB?.quantity ?? 0).toBe(0)

      // Notificaciones REALES: ganador y perdedor, cada uno con su propia fila.
      interface NotificationDocument {
        readonly changeType: string
        readonly playerId: string
      }
      const notificationsForBattle = await notificationsDb
        .collection<NotificationDocument>('catalog_notifications')
        .find({ sourceEventId: new RegExp(`^${roomId}:`) })
        .toArray()
      expect(notificationsForBattle).toHaveLength(2)
      expect(notificationsForBattle.map((n) => n.changeType).sort()).toEqual([
        'BATTLE_DROP_GAINED',
        'BATTLE_DROP_LOST',
      ])
      expect(
        notificationsForBattle.find((n) => n.changeType === 'BATTLE_DROP_GAINED')?.playerId,
      ).toBe(PLAYER_A)
      expect(
        notificationsForBattle.find((n) => n.changeType === 'BATTLE_DROP_LOST')?.playerId,
      ).toBe(PLAYER_B)

      // HU-29: ambos compromisos quedan liberados tras la liquidacion completa.
      const commitmentA = await piDb
        .collection('battle-hero-commitments')
        .findOne({ playerId: PLAYER_A, reference: roomId })
      const commitmentB = await piDb
        .collection('battle-hero-commitments')
        .findOne({ playerId: PLAYER_B, reference: roomId })
      expect(commitmentA?.status).toBe('RELEASED')
      expect(commitmentB?.status).toBe('RELEASED')
    })

    it('un segundo tick no duplica la transferencia ni cambia el ownership', async () => {
      const before = await piDb.collection('battle-drop-transfers').countDocuments({})

      const scheduler = app.get(IntervalBattleDropScheduler)
      await scheduler.tick()
      await scheduler.tick()

      const after = await piDb.collection('battle-drop-transfers').countDocuments({})
      expect(after).toBe(before)

      const unitStillWithA = await piDb
        .collection('battle-drop-units')
        .findOne({ itemId: WEAPON_GUARANTEED_PRODUCT_ID })
      expect(unitStillWithA?.ownerId).toBe(PLAYER_A)
    })
  })

  describe('E-14 — seguridad interna real de las rutas de drop', () => {
    it('capturar una instantanea sin HMAC se rechaza (401)', async () => {
      const response = await fetch(
        `${playerInventory.baseUrl}/api/internal/v1/inventory/battle-drops/snapshots`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            battleId: 'sala-cualquiera',
            playerId: PLAYER_B,
            heroId: HERO_B_PRODUCT_ID,
            loadoutVersion: 0,
          }),
        },
      )
      expect(response.status).toBe(401)
    })

    it('notificar un drop a Notifications sin HMAC se rechaza (401)', async () => {
      const response = await fetch(`${notifications.baseUrl}/api/internal/v1/notifications/combat/drop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          battleId: 'sala-cualquiera',
          defeatEventSeq: 1,
          role: 'GAINED',
          recipientId: PLAYER_A,
          productInstanceId: 'x',
          productId: 'y',
          itemId: 'z',
          creditedAt: new Date().toISOString(),
        }),
      })
      expect(response.status).toBe(401)
    })
  })
})
