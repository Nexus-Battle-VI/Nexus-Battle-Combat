/* eslint-disable @typescript-eslint/no-explicit-any -- las respuestas HTTP del servicio real son JSON dinamico; el contrato se verifica con las aserciones, no con tipos */
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
  type EquippedHeroEpic,
} from '../../../src/application/ports/PlayerInventoryEquippedHeroPort'
import {
  BATTLE_DEADLINE_SCHEDULER_OPTIONS,
  PROCESS_BATTLE_DEADLINES,
  REWARD_WORKFLOW_SCHEDULER_OPTIONS,
  USE_EPIC,
} from '../../../src/adapters/inbound/http/tokens'
import type { ProcessBattleDeadlines } from '../../../src/application/use-cases/ProcessBattleDeadlines'
import type { UseEpic } from '../../../src/application/use-cases/UseEpic'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../../src/application/ports/TokenVerifierPort'
import { REALTIME_GATEWAY_OPTIONS } from '../../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import { CLOCK, type ClockPort } from '../../../src/application/ports/ClockPort'
import { BATTLE_HERO_COMMITMENTS } from '../../../src/application/ports/BattleHeroCommitmentPort'
import {
  BATTLE_ROOM_REPOSITORY,
  type BattleRoomRepositoryPort,
} from '../../../src/application/ports/BattleRoomRepositoryPort'
import { ParticipantKind } from '../../../src/domain/entities/Participant'
import {
  BATTLE_DROP_INVENTORY,
  type BattleDropInventoryPort,
} from '../../../src/application/ports/BattleDropInventoryPort'
import {
  BATTLE_DROP_NOTIFIER,
  type BattleDropNotificationPort,
} from '../../../src/application/ports/BattleDropNotificationPort'
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
 * HU-31 de extremo a extremo, REAL (contrato `hu-31-equipped-epic-v1`):
 * Combat real (este proceso, HTTP real) -> HMAC real -> Player-Inventory
 * real (proceso Node aparte, su build de verdad) -> MongoDB real
 * (Testcontainers, un contenedor por servicio -- ADR-001). Mismo patron que
 * `test/e2e/hu-29/equipment-lock.e2e.spec.ts`; ver `jest.e2e-hu31.config.ts`.
 *
 * REAL en esta prueba:
 * - `PUT/GET /inventories/me/heroes/:heroId/epic` de Player-Inventory contra
 *   su Mongo real: ownership de heroe y de epica, persistencia de
 *   `HeroEpicSelection`, y resolucion de `applyEpicEffects` contra el doble
 *   minimo de Catalog (ver mas abajo).
 * - El bloqueo de batalla (HU-29) extendido a la epica (`decideEpicChange`,
 *   contrato §9): el compromiso que lo activa es el MISMO
 *   `PlayerInventoryBattleCommitmentHttpClient` real que Combat ya usa para
 *   HU-29, sin doblar -- `StartBattle` real compromete contra Player-
 *   Inventory real, y el `PUT .../epic` real lo rechaza con 409 mientras
 *   ese compromiso este vigente.
 * - El ciclo de vida completo de la sala de Combat (create/join/start/
 *   vencimiento global -> finish) contra su propio Mongo real, y la
 *   congelacion real de `CombatProfile.epic` en el documento persistido
 *   (migracion 020).
 *
 * SUSTITUIDO, declarado explicitamente, por ser ajeno a HU-31 e
 * imprescindible solo para construir el fixture (mismo criterio que
 * HU-29/HU-30):
 * - `TOKEN_VERIFIER` y `ACCOUNT_BATTLE_PROFILE` de Combat (JWT/Cognito y
 *   perfil de cuenta no son parte de HU-31).
 * - `PLAYER_INVENTORY_EQUIPPED_HERO` de Combat: mismo criterio que
 *   HU-29/HU-30 (ninguna de las dos E2E existentes hace viajar
 *   `equipped-hero` por HTTP real; lo que SI es real en ambas, y en esta, es
 *   el compromiso de batalla). El doble de ESTA prueba es MUTABLE y
 *   refleja, campo `epic`, exactamente lo que el `PUT .../epic` REAL acaba
 *   de persistir en Player-Inventory -- no un valor inventado aparte-- para
 *   que la congelacion en `CombatProfile.epic` (Combat) sea la proyeccion
 *   fiel de un estado que SI se escribio de verdad.
 * - El propio `CatalogReadPort` de Player-Inventory: servidor HTTP minimo
 *   levantado por esta prueba, que sirve el contrato canonico de Catalog v1
 *   para un heroe y dos epicas (una de subtipo coincidente, otra no).
 *   Catalog es HU-33, no HU-31; sin el, Player-Inventory no podria resolver
 *   ningun producto.
 * - El reloj que firma el HMAC saliente de Combat (no el puerto ni la
 *   clase, igual que HU-29/HU-30): tiempo real para el sello, independiente
 *   del reloj de juego mutable de esta prueba.
 * - `BattleDropInventoryPort`/`BattleDropNotificationPort` (HU-30, ajeno a
 *   HU-31): `StartBattle` los invoca para CUALQUIER battalla real desde que
 *   HU-30 se mergeo, pero esta prueba no siembra equipamiento 2/6/2 (solo la
 *   epica, que nunca es candidata a drop) ni verifica nada de esa HU. Doble
 *   minimo, sin red real, para no acoplar esta prueba a un contrato ajeno.
 */

const PLAYER_ID = 'anonymous' // AUTH_MODE=disabled en Player-Inventory atribuye toda peticion a este sujeto.
const COMBAT_TOKEN = 'token-humano'
const INTERNAL_SECRET = 'secreto-e2e-hu-31'

const HERO_PRODUCT_ID = randomUUID()
const EPIC_MATCH_PRODUCT_ID = randomUUID() // compatibleHeroSubtype === GUERRERO_TANQUE (el del heroe)
const EPIC_NO_MATCH_PRODUCT_ID = randomUUID() // compatibleHeroSubtype !== GUERRERO_TANQUE
const EPIC_UNOWNED_PRODUCT_ID = randomUUID() // existe en Catalog, pero el jugador nunca la posee

const PI_REPO_PATH =
  process.env.PLAYER_INVENTORY_REPO_PATH ??
  path.resolve(__dirname, '../../../../../Player-Inventory/Nexus-Battle-Player-Inventory')

// -----------------------------------------------------------------------
// Fixtures de Catalog v1 (EpicAttributes: compatibleHeroSubtype,
// generalEffect, specificEffect -- mismo sobre canonico que
// Player-Inventory/src/domain/policies/hero-epic-effects.ts).
// -----------------------------------------------------------------------
const catalogProducts: Record<string, unknown> = {
  [HERO_PRODUCT_ID]: {
    productId: HERO_PRODUCT_ID,
    sku: 'guerrero-tanque-e2e-hu31',
    name: 'Guerrero Tanque (E2E HU-31)',
    imageUrl: 'https://assets.example.test/guerrero-tanque.png',
    description: 'Heroe de la prueba de extremo a extremo de HU-31.',
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
  [EPIC_MATCH_PRODUCT_ID]: {
    productId: EPIC_MATCH_PRODUCT_ID,
    sku: 'golpe-de-defensa-e2e-hu31',
    name: 'Golpe de defensa (E2E HU-31)',
    imageUrl: 'https://assets.example.test/golpe-de-defensa.png',
    description: 'Epica de subtipo coincidente, con DOS efectos especificos simultaneos.',
    type: 'EPICA',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 0,
    premium: false,
    realMoneyPrice: null,
    attributes: {
      schemaVersion: '1',
      values: {
        kind: 'EPICA',
        compatibleHeroSubtype: 'GUERRERO_TANQUE',
        generalEffect: {
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'DEFENSE',
          operation: 'INCREASE',
          magnitude: { mode: 'FIXED', amount: 4 },
        },
        // GAP-HU31-CATALOG-MULTI-EFFECT: forma canonica specificEffects[], DOS
        // efectos simultaneos (igual que Golpe de defensa real, Tabla 20).
        specificEffects: [
          {
            kind: 'STAT_MODIFIER',
            target: 'SELF',
            statistic: 'DAMAGE',
            operation: 'INCREASE',
            magnitude: { mode: 'FIXED', amount: 4 },
          },
          {
            kind: 'STAT_MODIFIER',
            target: 'SELF',
            statistic: 'CRITICAL_CHANCE',
            operation: 'INCREASE',
            magnitude: { mode: 'FIXED', amount: 2 },
          },
        ],
        powerCost: 0,
        cooldownTurns: 2,
      },
    },
  },
  [EPIC_NO_MATCH_PRODUCT_ID]: {
    productId: EPIC_NO_MATCH_PRODUCT_ID,
    sku: 'luz-cegadora-e2e-hu31',
    name: 'Luz cegadora (E2E HU-31)',
    imageUrl: 'https://assets.example.test/luz-cegadora.png',
    description: 'Epica de subtipo NO coincidente con el heroe de esta prueba.',
    type: 'EPICA',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 0,
    premium: false,
    realMoneyPrice: null,
    attributes: {
      schemaVersion: '1',
      values: {
        kind: 'EPICA',
        compatibleHeroSubtype: 'MEDICO',
        generalEffect: {
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'DEFENSE',
          operation: 'INCREASE',
          magnitude: { mode: 'FIXED', amount: 1 },
        },
        // Forma LEGADA (specificEffect, un unico objeto), deliberada: prueba la
        // compatibilidad retroactiva real de la correccion GAP-HU31-CATALOG-MULTI-EFFECT
        // en el mismo E2E que ejercita la forma canonica (specificEffects[]) arriba.
        specificEffect: {
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'ATTACK',
          operation: 'INCREASE',
          magnitude: { mode: 'FIXED', amount: 5 },
        },
        powerCost: 0,
        cooldownTurns: 2,
      },
    },
  },
  [EPIC_UNOWNED_PRODUCT_ID]: {
    productId: EPIC_UNOWNED_PRODUCT_ID,
    sku: 'epica-no-poseida-e2e-hu31',
    name: 'Epica no poseida (E2E HU-31)',
    imageUrl: '',
    description: 'Existe en Catalog, pero el jugador de esta prueba nunca la posee.',
    type: 'EPICA',
    lifecycleStatus: 'ACTIVE',
    creditsPrice: 0,
    premium: false,
    realMoneyPrice: null,
    attributes: {
      schemaVersion: '1',
      values: {
        kind: 'EPICA',
        compatibleHeroSubtype: 'GUERRERO_TANQUE',
        specificEffect: {
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'ATTACK',
          operation: 'INCREASE',
          magnitude: { mode: 'FIXED', amount: 9 },
        },
        powerCost: 0,
        cooldownTurns: 2,
      },
    },
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
// Player-Inventory real: build de produccion + proceso Node aparte. Mismo
// patron, literal, que `test/e2e/hu-29/equipment-lock.e2e.spec.ts`.
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
        'jest.e2e-hu31.config.ts.',
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

  const port = 23_000 + Math.floor(Math.random() * 4_000)
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
// Combat real (en proceso, HTTP real sobre un puerto efimero).
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

// HU-30, ajeno a HU-31: `StartBattle` captura una instantanea de drop por
// cada humano al iniciar (CaptureBattleDropSnapshot). Sin equipamiento
// 2/6/2 sembrado en esta prueba (solo se siembra la epica, que nunca es
// candidata a drop -- hu-30-versus-drop-v1 §1), la instantanea real estaria
// vacia de todas formas; se sustituye por un doble minimo para no acoplar
// esta prueba a una ruta y un contrato que no son los que verifica.
const dropInventory: BattleDropInventoryPort = {
  capture: (command) => Promise.resolve({ ...command, equipment: [] }),
  find: (battleId, playerId) =>
    Promise.resolve({
      battleId,
      playerId,
      heroId: HERO_PRODUCT_ID,
      loadoutVersion: 0,
      equipment: [],
    }),
  transfer: () =>
    Promise.reject(new Error('HU-31 E2E: BattleDropInventoryPort.transfer no deberia invocarse.')),
  closeBattle: () => Promise.resolve(),
}

const dropNotifier: BattleDropNotificationPort = {
  notify: () => Promise.resolve(),
}

/**
 * El doble de `equipped-hero` (ver cabecera, "SUSTITUIDO") implementa el
 * PUERTO de Combat, no el contrato HTTP de Player-Inventory: debe incluir
 * `executableEffects`, que Player-Inventory NUNCA publica (lo construye
 * `PlayerInventoryHttpClient.parseEpic` en el lado de Combat). Se replica
 * aqui esa misma construccion -- baseApplied (si no null) + TODOS los
 * additionalApplied -- para que el doble sea fiel al puerto real, no solo
 * al JSON crudo que acaba de persistir Player-Inventory.
 */
const toPortEpic = (raw: Record<string, unknown>): EquippedHeroEpic => {
  const applied = raw.applied as { baseApplied: unknown; additionalApplied: readonly unknown[] }
  // `applied.baseApplied`/`additionalApplied` son el efecto de Catalog tal cual (sin
  // `hasActivationCondition`: ese campo es de HABILIDAD, no de epica) -- mismo criterio
  // que `parseEpicExecutableEffect` en `PlayerInventoryHttpClient.ts`, que este doble
  // replica a mano porque el puerto se sustituye directamente en esta prueba.
  const withDefaults = (effect: unknown): unknown => ({
    hasActivationCondition: false,
    ...(effect as Record<string, unknown>),
  })
  return {
    ...raw,
    executableEffects: [
      ...(applied.baseApplied === null ? [] : [withDefaults(applied.baseApplied)]),
      ...applied.additionalApplied.map(withDefaults),
    ],
  } as unknown as EquippedHeroEpic
}

// Mutable: el PUT real a Player-Inventory actualiza esta variable justo
// despues de confirmarse, para que el doble de equipped-hero proyecte el
// MISMO estado que de verdad se persistio (ver cabecera, "SUSTITUIDO").
let currentEpic: EquippedHeroEpic | undefined
const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(
      equippedHeroFixture({
        playerId,
        heroId: HERO_PRODUCT_ID,
        reference: 'guerrero-tanque-e2e-hu31',
        subtype: 'GUERRERO_TANQUE',
        ready: true,
        blockers: [],
        loadoutVersion: 0,
        // Sin habilidades: este heroe solo tiene la epica, para que la
        // recarga/los efectos que verifica este E2E no dependan de HU-19
        // (habilidades), que es un contrato ajeno a HU-31.
        abilities: [],
        ...(currentEpic === undefined ? {} : { epic: currentEpic }),
      }),
    ),
}

describe('HU-31 de extremo a extremo REAL: epica equipada, bloqueada en batalla y congelada en el snapshot', () => {
  let piMongoContainer: StartedMongoDBContainer
  let combatMongoContainer: StartedMongoDBContainer
  let combatMongo: MongoClient
  let combatDb: Db
  let catalogMock: { server: Server; baseUrl: string }
  let playerInventory: PlayerInventoryProcess
  let app: INestApplication
  let restoreEnv: () => void
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

  const getEpic = (): Promise<{ status: number; body: any }> =>
    piFetch(`/api/inventories/me/heroes/${HERO_PRODUCT_ID}/epic`)

  const putEpic = (productReference: string): Promise<{ status: number; body: any }> =>
    piFetch(`/api/inventories/me/heroes/${HERO_PRODUCT_ID}/epic`, {
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

    // Siembra: el jugador "anonymous" posee el heroe y las dos epicas que SI
    // va a equipar (coincidente y no coincidente). Deliberadamente NO se
    // otorga `EPIC_UNOWNED_PRODUCT_ID`: existe en Catalog, pero nunca en el
    // inventario de este jugador (E2E-04, ownership).
    for (const productId of [HERO_PRODUCT_ID, EPIC_MATCH_PRODUCT_ID, EPIC_NO_MATCH_PRODUCT_ID]) {
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
      INTERNAL_SERVICE_AUTH_SECRET: INTERNAL_SECRET,
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: combatMongoUri,
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
      // NO se sustituye: es la pieza que esta prueba existe para verificar
      // de verdad (HU-29 §9 extendido a la epica). Mismo motivo que
      // HU-29/HU-30 para el reloj del sello HMAC.
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
      .overrideProvider(BATTLE_DROP_INVENTORY)
      .useValue(dropInventory)
      .overrideProvider(BATTLE_DROP_NOTIFIER)
      .useValue(dropNotifier)
      .overrideProvider(CLOCK)
      .useValue(clock)
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
    if (process.env.HU31_E2E_DEBUG === '1') {
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

  it('E2E-04 — una epica no poseida se rechaza (404), real', async () => {
    const attempt = await putEpic(EPIC_UNOWNED_PRODUCT_ID)
    expect(attempt.status).toBe(404)

    const read = await getEpic()
    expect(read.body.epic).toBeNull()
  })

  it('E2E-01/E2E-03 — equipar una epica de subtipo coincidente, real, y releer confirma persistencia', async () => {
    const put = await putEpic(EPIC_MATCH_PRODUCT_ID)
    expect(put.status).toBe(200)
    expect(put.body.epic.epicReference).toBe('golpe-de-defensa-e2e-hu31')
    expect(put.body.epic.applied.baseApplied).not.toBeNull()
    expect(put.body.epic.applied.additionalApplied).toHaveLength(2)
    expect(put.body.locked).toBe(false)

    // Nueva peticion independiente: la seleccion sigue siendo la misma.
    const read = await getEpic()
    expect(read.status).toBe(200)
    expect(read.body.epic.epicReference).toBe('golpe-de-defensa-e2e-hu31')
    expect(read.body.version).toBe(put.body.version)

    // El doble de equipped-hero (ver cabecera) proyecta este MISMO estado
    // real, para que StartBattle lo congele fielmente.
    currentEpic = toPortEpic(read.body.epic as Record<string, unknown>)
  })

  it('E2E-07(PVE)/T-C-01 — inicio real: StartBattle compromete contra Player-Inventory real; el snapshot congela base+especifico', async () => {
    const rooms = app.get<BattleRoomRepositoryPort>(BATTLE_ROOM_REPOSITORY)

    // HU-17: el orden de turnos se sortea de verdad (motor HU-24 real, sin
    // doblar -- ver cabecera). El escenario de ejecucion real necesita que el
    // HUMANO actue primero (no hay IA que juegue su propio turno en esta
    // prueba); crear una sala nueva hasta que el sorteo lo de es legitimo
    // (ninguna composicion/semilla esta ratificada) y no oculta ningun fallo:
    // cada sala descartada es un sorteo real distinto, no un reintento de la
    // MISMA operacion.
    let humanGoesFirst = false
    const deadlines = app.get<ProcessBattleDeadlines>(PROCESS_BATTLE_DEADLINES)

    for (let attempt = 0; attempt < 20 && !humanGoesFirst; attempt += 1) {
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

      const started = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth())
      expect(started.status).toBe(200)
      expect(started.body.status).toBe('IN_BATTLE')

      const freshRoom = await rooms.findById(roomId)
      humanGoesFirst = freshRoom?.battle?.currentEntry.kind === ParticipantKind.Human

      if (!humanGoesFirst) {
        // El compromiso de batalla (HU-29) del heroe sigue ACTIVO en la sala
        // descartada -- un heroe solo puede tener UN compromiso vigente a la
        // vez (indice parcial de Player-Inventory). Hay que liberarlo antes
        // del siguiente sorteo, o el commit del proximo intento se rechaza
        // (HERO_COMMITTED), nunca por una causa nueva: mismo mecanismo real
        // de vencimiento/liberacion que E2E-05 (cont.) mas abajo.
        clock.advance(6 * 60_000 + 1)
        await deadlines.execute(roomId)
      }
    }

    expect(humanGoesFirst).toBe(true)

    // Snapshot REAL, leido directamente del repositorio real de Combat
    // (mismo Mongo real que acaba de persistir `started`).
    const room = await rooms.findById(roomId)
    const profile = room?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.profile
    expect(profile?.epic?.epicReference).toBe('golpe-de-defensa-e2e-hu31')
    expect(profile?.epic?.applied.baseApplied).not.toBeNull()
    expect(profile?.epic?.applied.additionalApplied).toHaveLength(2)
    // GAP-HU31-CATALOG-MULTI-EFFECT: executableEffects trae los 3 (general + 2
    // especificos), ya validados como efecto de habilidad real -- lo que
    // `UseEpic` ejecutara de verdad en el siguiente escenario.
    expect(profile?.epic?.executableEffects).toHaveLength(3)
  })

  it('correccion HU-19/HU-31 — usar la epica REAL: Poder sin cambios, recarga 2, los 3 efectos simultaneos aplicados y persistidos', async () => {
    const useEpic = app.get<UseEpic>(USE_EPIC)
    const result = await useEpic.execute({
      roomId,
      requesterId: PLAYER_ID,
      commandId: randomUUID(),
    })

    expect(result.replayed).toBe(false)
    expect(result.event.type).toBe('epicUsed')

    const payload = result.event.payload as {
      readonly power: { readonly before: number; readonly after: number }
      readonly cooldown: { readonly remainingTurns: number }
      readonly appliedEffects: number
    }
    // El costo de la epica es SIEMPRE 0 (Catalog, confirmado arriba): el
    // Poder del heroe no cambia, sea cual sea su valor real (base x nivel,
    // HU-08 CA-06 -- no se fija aqui un numero de memoria).
    expect(payload.power.after).toBe(payload.power.before)
    expect(payload.power.before).toBeGreaterThan(0)
    expect(payload.cooldown).toEqual({ remainingTurns: 2 })
    expect(payload.appliedEffects).toBe(3)

    // Persistido de verdad: se relee el mismo Mongo real de Combat, en una
    // peticion/consulta INDEPENDIENTE de la que acabo de escribir.
    const rooms = app.get<BattleRoomRepositoryPort>(BATTLE_ROOM_REPOSITORY)
    const reread = await rooms.findById(roomId)
    const actor = reread?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })
    expect(actor?.activeSkillEffects).toHaveLength(3)
    expect(actor?.cooldownOf(EPIC_MATCH_PRODUCT_ID)).toBe(2)
    // La recarga/los efectos de la epica NO dependen de ninguna habilidad:
    // este heroe no tiene ninguna congelada (abilities: [] en el fixture).
    expect(reread?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.abilities).toHaveLength(0)
  })

  it('E2E-05 — con batalla activa, cambiar la epica se rechaza (409 battle_lock), real', async () => {
    const attempt = await putEpic(EPIC_NO_MATCH_PRODUCT_ID)

    expect(attempt.status).toBe(409)
    expect(attempt.body.reason).toBe('battle_lock')
    expect(typeof attempt.body.message).toBe('string')

    // El rechazo no cambio nada: sigue equipada la misma epica de antes.
    const read = await getEpic()
    expect(read.body.epic.epicReference).toBe('golpe-de-defensa-e2e-hu31')
    expect(read.body.locked).toBe(true)
  })

  it('E2E-05 (cont.) — tras finalizar la batalla, la mutacion vuelve a permitirse', async () => {
    // Mismo mecanismo real que HU-21/HU-29: avanzar el reloj mas alla del
    // vencimiento global y pedirle al caso de uso real que liquide la sala.
    clock.advance(6 * 60_000 + 1)
    const deadlines = app.get<ProcessBattleDeadlines>(PROCESS_BATTLE_DEADLINES)
    await deadlines.execute(roomId)

    const finished = await http().get(`/api/v1/combat/rooms/${roomId}`).set('Authorization', auth())
    expect(finished.body.status).toBe('FINISHED')

    // BattleFinalizer libera el compromiso en segundo plano (fire-and-forget,
    // mismo criterio que HU-29): se espera a que Player-Inventory lo refleje.
    const deadline = Date.now() + 10_000
    let unlocked = false
    while (Date.now() < deadline) {
      const read = await getEpic()
      if (read.body.locked === false) {
        unlocked = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(unlocked).toBe(true)

    const retry = await putEpic(EPIC_NO_MATCH_PRODUCT_ID)
    expect(retry.status).toBe(200)
    expect(retry.body.epic.epicReference).toBe('luz-cegadora-e2e-hu31')
  })

  it('T-C-03 — subtipo NO coincidente: el snapshot de una nueva batalla congela solo el efecto base', async () => {
    // El GET real ya confirma, fuera de combate, que el especifico no se
    // aplica con esta epica (subtipo MEDICO != GUERRERO_TANQUE del heroe).
    const read = await getEpic()
    expect(read.body.epic.applied.baseApplied).not.toBeNull()
    expect(read.body.epic.applied.additionalApplied).toEqual([])
    currentEpic = toPortEpic(read.body.epic as Record<string, unknown>)

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
    const secondRoomId = created.body.id as string

    await http()
      .post(`/api/v1/combat/rooms/${secondRoomId}/join`)
      .set('Authorization', auth())
      .send({})
    const started = await http()
      .post(`/api/v1/combat/rooms/${secondRoomId}/start`)
      .set('Authorization', auth())
    expect(started.body.status).toBe('IN_BATTLE')

    const rooms = app.get<BattleRoomRepositoryPort>(BATTLE_ROOM_REPOSITORY)
    const room = await rooms.findById(secondRoomId)
    const profile = room?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.profile
    expect(profile?.epic?.epicReference).toBe('luz-cegadora-e2e-hu31')
    expect(profile?.epic?.applied.baseApplied).not.toBeNull()
    expect(profile?.epic?.applied.additionalApplied).toEqual([])
  })
})
