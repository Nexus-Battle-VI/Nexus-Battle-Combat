import 'reflect-metadata'

import { Worker } from 'node:worker_threads'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import request from 'supertest'

import {
  ACCOUNT_BATTLE_PROFILE,
  type AccountBattleProfilePort,
} from '../../src/application/ports/AccountBattleProfilePort'
import {
  PLAYER_INVENTORY_EQUIPPED_HERO,
  type PlayerInventoryEquippedHeroPort,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule, DATABASE } from '../../src/infrastructure/bootstrap/app.module'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { equippedHeroFixture } from '../fixtures/equipped-hero'

/**
 * Latencia del chat de Jugar Online (HU-13, RF-13): «la distribucion de
 * mensajes forma parte de los flujos en tiempo real evaluados bajo el objetivo
 * de rendimiento (p95 < 500 ms)». El documento oficial (seccion 8) ademas pide
 * «informes de pruebas de latencia y carga».
 *
 * QUE MIDE. El tiempo entre que un cliente escribe `chat.send` y cada
 * destinatario recibe el `chat.message` correspondiente (por pareja mensaje x
 * destinatario), con conexiones WebSocket REALES, el modulo completo de Nest y
 * persistencia en MongoDB REAL (contenedor). Incluye la escritura durable
 * porque ADR-020 obliga a persistir antes de difundir. Se usa la configuracion
 * de PRODUCCION del chat (5 mensajes cada 10 s por remitente y canal) y la
 * reserva de conexiones por defecto del servicio (`maxPoolSize` 5).
 *
 * QUE NO MIDE (declarado, no oculto):
 * - Los clientes corren en un hilo aparte del MISMO proceso y la misma maquina:
 *   no hay red, y comparten CPU con el servidor y con MongoDB.
 * - MongoDB corre en un contenedor local, no en el nodo de datos.
 * - No es produccion, ni valida los 100.000 usuarios simultaneos del documento:
 *   ADR-020 fija UNA replica de Combat con difusion en memoria del proceso.
 *
 * ESCENARIOS.
 * - Lobby con 50, 200 y 500 conexiones: 100 mensajes espaciados (50 mensajes/s;
 *   cada mensaje se difunde a todas las conexiones). Con 1000 se informa el
 *   limite observado sin afirmar el objetivo.
 * - Salas, FLUJO SOSTENIDO: 40 salas x 4 jugadores, cada jugador escribe al
 *   ritmo maximo que admite el limitador de forma continua (5 mensajes cada
 *   10 s = uno cada 2 s), con las fases desfasadas. Es la carga maxima
 *   sostenida que el propio limitador permite (~80 mensajes/s en total).
 * - Salas, RAFAGA SINCRONIZADA: los 160 jugadores envian a la vez su rafaga
 *   completa de 5 mensajes (800 mensajes en ~0,4 s). El limitador lo permite
 *   (5 por ventana y remitente), pero es el peor caso, no la carga esperada.
 *   Se mide con la reserva de conexiones por defecto (5) y con 20 para
 *   distinguir si el cuello de botella es esa reserva. NO se afirma el objetivo
 *   de 500 ms sobre este escenario: se informa.
 *
 * No forma parte del CI (`npm run test:perf`): una medicion de tiempo en un
 * ejecutor compartido no es una prueba estable. Necesita Docker.
 */
const HU_TARGET_P95_MS = 500

const stubVerifier: TokenVerifierPort = {
  verify: (token) =>
    token.startsWith('t-')
      ? Promise.resolve({ subject: `sub-${token}`, email: null, roles: new Set([Role.Player]) })
      : Promise.reject(new TokenVerificationError()),
}

const stubAccount: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `Jugador ${subject}`, avatarUrl: null }),
}

const stubHeroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(equippedHeroFixture({ playerId, heroId: `heroe-${playerId}` })),
}

const percentile = (sorted: readonly number[], p: number): number => {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))

  return sorted[index] ?? Number.NaN
}

interface Stats {
  readonly samples: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly mean: number
}

const statsOf = (values: readonly number[]): Stats => {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)

  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: sum / Math.max(1, sorted.length),
  }
}

const fmt = (n: number): string => n.toFixed(1)

const describeStats = (label: string, s: Stats): string =>
  `${label.padEnd(38)} n=${String(s.samples).padStart(6)}  p50=${fmt(s.p50).padStart(7)} ms  p95=${fmt(s.p95).padStart(7)} ms  p99=${fmt(s.p99).padStart(7)} ms  max=${fmt(s.max).padStart(7)} ms  media=${fmt(s.mean).padStart(7)} ms`

/**
 * Los CLIENTES viven en un hilo aparte (`worker_threads`), no en el del
 * servidor. Con clientes y servidor en el mismo bucle de eventos, 500 clientes
 * que analizan decenas de miles de tramas medirian la propia prueba, no al
 * servidor (una primera version asi dio resultados que variaban de 20 ms a 1 s
 * entre ejecuciones identicas).
 *
 * La latencia se calcula DENTRO del hilo de los clientes, con un unico reloj:
 * `performance.now()` al escribir y `performance.now()` al recibir. No se
 * comparan relojes entre hilos.
 *
 * El codigo del worker va como texto porque se ejecuta como JavaScript plano,
 * sin pasar por ts-jest, y no usa plantillas de texto para poder viajar en una
 * cadena normal.
 */
const WORKER_SOURCE = [
  "const { parentPort, workerData } = require('node:worker_threads')",
  "const { performance } = require('node:perf_hooks')",
  'const WebSocket = require(workerData.wsPath)',
  'const url = workerData.url',
  'const peers = workerData.peers.map((spec, index) => ({ spec, index, socket: null, seqs: [], foreign: 0, rejections: [] }))',
  'const sentAt = new Map()',
  'const pair = []',
  'const ack = []',
  'const connect = (peer) => new Promise((resolve, reject) => {',
  '  const socket = new WebSocket(url)',
  '  peer.socket = socket',
  "  socket.on('error', reject)",
  "  socket.on('open', () => {",
  "    socket.send(JSON.stringify({ type: 'auth', token: peer.spec.token }))",
  "    socket.send(JSON.stringify(peer.spec.roomId === null ? { type: 'chat.subscribe', channel: 'lobby' } : { type: 'chat.subscribe', channel: 'room', roomId: peer.spec.roomId }))",
  '  })',
  "  socket.on('message', (data) => {",
  '    const now = performance.now()',
  '    const frame = JSON.parse(data.toString())',
  "    if (frame.type === 'chat.subscribed') { resolve() }",
  "    else if (frame.type === 'chat.message') {",
  '      peer.seqs.push(frame.seq)',
  '      const t0 = sentAt.get(frame.commandId)',
  '      if (t0 !== undefined) pair.push(now - t0)',
  '      const room = frame.roomId === undefined ? null : frame.roomId',
  '      if (room !== peer.spec.roomId) peer.foreign += 1',
  "    } else if (frame.type === 'chat.accepted') {",
  '      const t0 = sentAt.get(frame.commandId)',
  '      if (t0 !== undefined) ack.push(now - t0)',
  "    } else if (frame.type === 'command.rejected') { peer.rejections.push(String(frame.code)) }",
  '  })',
  '})',
  'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
  ';(async () => {',
  '  for (let i = 0; i < peers.length; i += 50) { await Promise.all(peers.slice(i, i + 50).map(connect)) }',
  "  parentPort.postMessage({ type: 'ready' })",
  "  await new Promise((resolve) => parentPort.once('message', resolve))",
  '  let pending = workerData.schedule.length',
  '  await new Promise((resolve) => {',
  '    for (const item of workerData.schedule) {',
  '      setTimeout(() => {',
  '        const peer = peers[item.peer]',
  '        sentAt.set(item.commandId, performance.now())',
  "        peer.socket.send(JSON.stringify(peer.spec.roomId === null ? { type: 'chat.send', channel: 'lobby', commandId: item.commandId, text: item.text } : { type: 'chat.send', channel: 'room', roomId: peer.spec.roomId, commandId: item.commandId, text: item.text }))",
  '        pending -= 1',
  '        if (pending === 0) resolve()',
  '      }, item.at)',
  '    }',
  '  })',
  '  const deadline = Date.now() + 30000',
  '  while (peers.some((p) => p.seqs.length < p.spec.expected) && Date.now() < deadline) { await sleep(20) }',
  "  parentPort.postMessage({ type: 'result', pair, ack, peers: peers.map((p) => ({ seqs: p.seqs, foreign: p.foreign, rejections: p.rejections, expected: p.spec.expected })) })",
  '  for (const p of peers) p.socket.close()',
  '})().catch((error) => { throw error })',
].join('\n')

interface PeerSpec {
  readonly token: string
  readonly roomId: string | null
  /** Mensajes que debe recibir este cliente en total. */
  readonly expected: number
}

interface ScheduledSend {
  /** Indice del cliente que escribe. */
  readonly peer: number
  /** Milisegundos desde la orden de inicio. */
  readonly at: number
  readonly commandId: string
  readonly text: string
}

interface PeerOutcome {
  readonly seqs: number[]
  readonly foreign: number
  readonly rejections: string[]
  readonly expected: number
}

interface WorkerResult {
  readonly pair: number[]
  readonly ack: number[]
  readonly peers: PeerOutcome[]
}

/** Ejecuta un escenario completo con los clientes en un hilo aparte y devuelve lo medido. */
const runScenario = async (
  url: string,
  peers: readonly PeerSpec[],
  schedule: readonly ScheduledSend[],
): Promise<WorkerResult> => {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { url, peers, schedule, wsPath: require.resolve('ws') },
  })

  return new Promise<WorkerResult>((resolve, reject) => {
    worker.on('error', reject)
    worker.on('message', (message: { type: string } & Partial<WorkerResult>) => {
      if (message.type === 'ready') {
        worker.postMessage('go')
      } else if (message.type === 'result') {
        void worker.terminate()
        resolve(message as WorkerResult)
      }
    })
  })
}

interface RunningApp {
  readonly app: INestApplication
  readonly url: string
  readonly baseUrl: string
}

describe('latencia del chat (HU-13) sobre conexiones WebSocket reales y MongoDB real', () => {
  let container: StartedMongoDBContainer
  let uri: string
  const previousEnv: Record<string, string | undefined> = {}
  const apps: INestApplication[] = []
  let cmd = 0
  const report: string[] = []

  const commandId = (): string => {
    cmd += 1

    return `00000000-0000-4000-8000-${String(cmd).padStart(12, '0')}`
  }

  const setEnv = (values: Record<string, string>): void => {
    for (const [key, value] of Object.entries(values)) {
      previousEnv[key] = process.env[key]
      process.env[key] = value
    }
  }

  /** Arranca el modulo completo con una reserva de conexiones de Mongo del tamano dado. */
  const startApp = async (poolSize: number): Promise<RunningApp> => {
    const client = createMongoClient({ uri, maxPoolSize: poolSize })

    await client.connect()

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(stubAccount)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(stubHeroes)
      .overrideProvider(DATABASE)
      .useValue(databaseOf(client, { uri }))
      .compile()

    const app = moduleRef.createNestApplication()

    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.listen(0, '127.0.0.1')
    apps.push(app)

    const address = app.getHttpServer().address() as { port: number }

    return {
      app,
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      url: `ws://127.0.0.1:${String(address.port)}/api/v1/combat/realtime`,
    }
  }

  /** Crea `rooms` salas de 4 (PVP 2 contra 2), las llena por HTTP y devuelve un cliente por jugador. */
  const seatRooms = async (
    running: RunningApp,
    rooms: number,
    prefix: string,
    expected: number,
  ): Promise<PeerSpec[]> => {
    const authed = (token: string) => (req: request.Test) =>
      req.set('Authorization', `Bearer ${token}`)
    const specs: PeerSpec[] = []

    for (let r = 0; r < rooms; r += 1) {
      const created = await authed('t-creador')(
        request(running.baseUrl)
          .post('/api/v1/combat/rooms')
          .send({
            mode: 'PVP',
            teamConfigs: [{ capacity: 2 }, { capacity: 2 }],
            reward: { amount: 0 },
          }),
      )
      const roomId = (created.body as { id: string }).id

      for (let p = 0; p < 4; p += 1) {
        const token = `t-${prefix}-room${String(r)}-p${String(p)}`
        const joined = await authed(token)(
          request(running.baseUrl).post(`/api/v1/combat/rooms/${roomId}/join`).send({}),
        )

        expect(joined.status).toBe(200)
        specs.push({ token, roomId, expected })
      }
    }

    return specs
  }

  /** Estadisticas por pareja mensaje x destinatario y comprobaciones de integridad y aislamiento. */
  const summarize = (title: string, result: WorkerResult): Stats => {
    const pair = statsOf(result.pair)

    report.push(
      `--- ${title} (${String(result.pair.length)} entregas) ---`,
      describeStats('pareja mensaje x destinatario', pair),
      describeStats('envio -> chat.accepted (remitente)', statsOf(result.ack)),
    )

    for (const peer of result.peers) {
      // Cada cliente recibe SOLO los mensajes de su canal, todos, en orden y sin repetidos.
      expect(peer.rejections).toEqual([])
      expect(peer.seqs).toHaveLength(peer.expected)
      expect(peer.seqs).toEqual([...peer.seqs].sort((a, b) => a - b))
      expect(new Set(peer.seqs).size).toBe(peer.expected)
      expect(peer.foreign).toBe(0)
    }

    return pair
  }

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    uri = `${container.getConnectionString()}/?directConnection=true`

    const client = createMongoClient({ uri })

    await client.connect()
    const { error } = await migrateToLatest(databaseOf(client, { uri }))

    await client.close()

    if (error !== undefined) {
      throw new Error('Las migraciones fallaron')
    }

    // Configuracion de PRODUCCION del chat: no se toca el limitador.
    setEnv({
      NODE_ENV: 'test',
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: uri,
      LOG_LEVEL: 'error',
    })
  }, 300_000)

  afterAll(async () => {
    for (const line of report) {
      process.stdout.write(`${line}\n`)
    }

    for (const app of apps.splice(0)) {
      await app.close()
    }

    await container.stop()

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }, 120_000)

  describe.each([
    [50, true],
    [200, true],
    [500, true],
    // Limite observado: se informa, no se afirma el objetivo (ver el encabezado).
    [1000, false],
  ] as const)('lobby con %i conexiones simultaneas', (connections, assertTarget) => {
    const MESSAGES = 100
    const INTERVAL_MS = 20

    it(`${String(MESSAGES)} mensajes a ${String(INTERVAL_MS)} ms entre si: entrega completa, en orden, y p95 < ${String(HU_TARGET_P95_MS)} ms`, async () => {
      const running = await startApp(5)
      const specs: PeerSpec[] = Array.from({ length: connections }, (_v, i) => ({
        token: `t-lobby-${String(connections)}-${String(i)}`,
        roomId: null,
        expected: MESSAGES,
      }))
      const schedule: ScheduledSend[] = Array.from({ length: MESSAGES }, (_v, i) => ({
        peer: i % connections,
        at: i * INTERVAL_MS,
        commandId: commandId(),
        text: `mensaje ${String(i)}`,
      }))

      const result = await runScenario(running.url, specs, schedule)
      const pair = summarize(
        `Lobby: ${String(connections)} conexiones, ${String(MESSAGES)} mensajes${assertTarget ? '' : ' (limite observado)'}`,
        result,
      )

      if (assertTarget) {
        expect(pair.p95).toBeLessThan(HU_TARGET_P95_MS)
      } else {
        report.push(
          `    -> objetivo p95 < ${String(HU_TARGET_P95_MS)} ms: ${pair.p95 < HU_TARGET_P95_MS ? 'SE CUMPLE' : 'NO SE CUMPLE'} en este escenario`,
        )
      }
    }, 240_000)
  })

  describe('40 salas de 4 jugadores', () => {
    const ROOMS = 40
    const PLAYERS = ROOMS * 4
    const PER_PLAYER = 5

    it(`FLUJO SOSTENIDO al maximo que admite el limitador (un mensaje cada 2 s por jugador): p95 < ${String(HU_TARGET_P95_MS)} ms`, async () => {
      const running = await startApp(5)
      const specs = await seatRooms(running, ROOMS, 'sost', 4 * PER_PLAYER)
      // Fases desfasadas dentro de un periodo de 2 s: no hay rondas sincronizadas.
      const schedule: ScheduledSend[] = specs.flatMap((_spec, index) =>
        Array.from({ length: PER_PLAYER }, (_v, k) => ({
          peer: index,
          at: (index / PLAYERS) * 2_000 + k * 2_000,
          commandId: commandId(),
          text: `mensaje ${String(k)}`,
        })),
      )

      const result = await runScenario(running.url, specs, schedule)
      const pair = summarize(
        `Salas, FLUJO SOSTENIDO: ${String(ROOMS)} salas x 4 jugadores, ${String(PLAYERS * PER_PLAYER)} mensajes (~80 msg/s), reserva Mongo 5`,
        result,
      )

      expect(pair.p95).toBeLessThan(HU_TARGET_P95_MS)
    }, 300_000)

    describe.each([5, 20])(
      'RAFAGA SINCRONIZADA con reserva de conexiones de Mongo = %i (se informa; no se afirma el objetivo)',
      (poolSize) => {
        it('los 160 jugadores envian su rafaga completa a la vez: entrega completa, en orden y sin fugas entre salas', async () => {
          const running = await startApp(poolSize)
          const specs = await seatRooms(running, ROOMS, `raf${String(poolSize)}`, 4 * PER_PLAYER)
          // 10 mensajes cada 5 ms: ~2000 mensajes por segundo, 800 en ~0,4 s.
          const schedule: ScheduledSend[] = []
          let sent = 0

          for (let round = 0; round < PER_PLAYER; round += 1) {
            for (let index = 0; index < PLAYERS; index += 1) {
              schedule.push({
                peer: index,
                at: Math.floor(sent / 10) * 5,
                commandId: commandId(),
                text: `rafaga ${String(round)}`,
              })
              sent += 1
            }
          }

          const result = await runScenario(running.url, specs, schedule)
          const pair = summarize(
            `Salas, RAFAGA SINCRONIZADA: ${String(PLAYERS * PER_PLAYER)} mensajes en ~0,4 s (~2000 msg/s), reserva Mongo ${String(poolSize)}`,
            result,
          )

          report.push(
            `    -> objetivo p95 < ${String(HU_TARGET_P95_MS)} ms: ${pair.p95 < HU_TARGET_P95_MS ? 'SE CUMPLE' : 'NO SE CUMPLE'} en este escenario`,
          )
        }, 300_000)
      },
    )
  })
})
