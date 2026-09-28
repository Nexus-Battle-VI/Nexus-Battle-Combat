/* eslint-disable @typescript-eslint/no-explicit-any -- las respuestas y eventos del servidor real son JSON dinamico; el contrato se verifica con las aserciones */
import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { type Db, type MongoClient, MongoServerError } from 'mongodb'
import { WebSocket } from 'ws'

import { COMPLETE_BATTLE_TURN, RESUME_BATTLE } from '../../src/adapters/inbound/http/tokens'
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
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import type { CompleteBattleTurn } from '../../src/application/use-cases/CompleteBattleTurn'
import type { ResumeBattle } from '../../src/application/use-cases/ResumeBattle'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { BATTLE_HERO_COMMITMENTS } from '../../src/application/ports/BattleHeroCommitmentPort'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'
import { equippedHeroFixture } from '../fixtures/equipped-hero'

/**
 * VALIDACION INTEGRADA DE HU-17 (Task #408) a nivel de PROTOCOLO, sin dobles del
 * transporte ni de la base: MongoDB REAL (Testcontainers), un servidor Nest REAL
 * escuchando en un puerto y DOS clientes WebSocket REALES (`ws`), cada uno con
 * su propio `sub`, su propio ticket y su propia conexion.
 *
 * Solo se sustituyen las fronteras EXTERNAS a Combat: la verificacion del
 * JWT de Cognito, Account y Player-Inventory (que no estan disponibles aqui).
 *
 * Flujo: sala preparada -> HU-16 -> inicio -> cola generada con HU-24 ->
 * battleStarted a ambos clientes -> mismo orden y mismo turno -> avance de turno
 * en el servidor -> reconexion con `resume` -> el estado sobrevive a un reinicio.
 */
const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-a': { subject: 'sujeto-a', email: null, roles: new Set([Role.Player]) },
  'token-b': { subject: 'sujeto-b', email: null, roles: new Set([Role.Player]) },
  'token-c': { subject: 'sujeto-c', email: null, roles: new Set([Role.Player]) },
}

const verifier: TokenVerifierPort = {
  verify: (token) => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const accounts: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `nombre-de-${subject}`, avatarUrl: null }),
}

const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(
      equippedHeroFixture({
        playerId,
        heroId: `heroe-de-${playerId}`,
        subtype: playerId === 'sujeto-a' ? 'GUERRERO_ARMAS' : 'MAGO_FUEGO',
        loadoutVersion: 0,
      }),
    ),
}

/** Cliente WebSocket con su bandeja de mensajes y sus cierres. */
class Client {
  readonly raw: string[] = []
  readonly closes: number[] = []

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.raw.push(
        Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(Buffer.concat([Buffer.from(data as ArrayBuffer)])),
      )
    })
    ws.on('close', (code) => {
      this.closes.push(code)
    })
  }

  get messages(): Record<string, unknown>[] {
    return this.raw.map((text) => JSON.parse(text) as Record<string, unknown>)
  }

  ofType(type: string): Record<string, unknown>[] {
    return this.messages.filter((message) => message.type === type)
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload))
  }

  async waitFor(type: string, count = 1, timeoutMs = 5_000): Promise<Record<string, unknown>[]> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.ofType(type).length >= count) {
        return this.ofType(type)
      }

      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    throw new Error(
      `No llego ${String(count)} mensaje(s) "${type}" en ${String(timeoutMs)} ms: ${this.raw.join(' | ')}`,
    )
  }

  async waitClose(timeoutMs = 8_000): Promise<number> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.closes.length > 0) {
        return this.closes[0] ?? -1
      }

      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    throw new Error('La conexion no se cerro a tiempo')
  }

  close(): void {
    this.ws.close()
  }
}

describe('HU-17 de extremo a extremo (protocolo): dos clientes WebSocket reales contra Combat + MongoDB', () => {
  let container: StartedMongoDBContainer
  let mongo: MongoClient
  let db: Db
  let mongoUri: string
  let app: INestApplication
  let complete: CompleteBattleTurn
  let resume: ResumeBattle
  let port: number
  let restoreEnv: () => void

  const boot = async (): Promise<void> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(accounts)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(heroes)
      // HU-29: el compromiso de equipamiento es una llamada saliente a
      // Player/Inventory; aqui se sustituye por un doble (el cliente HTTP tiene su
      // propia prueba unitaria).
      .overrideProvider(BATTLE_HERO_COMMITMENTS)
      .useValue(recordingBattleCommitments())
      .compile()

    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.listen(0, '127.0.0.1')

    const address = app.getHttpServer().address() as { port: number }

    port = address.port
    complete = moduleRef.get<CompleteBattleTurn>(COMPLETE_BATTLE_TURN, { strict: false })
    resume = moduleRef.get<ResumeBattle>(RESUME_BATTLE, { strict: false })
  }

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    mongoUri = `${container.getConnectionString()}/?directConnection=true`

    const options = { uri: mongoUri }

    mongo = createMongoClient(options)
    await mongo.connect()
    db = databaseOf(mongo, options)

    const { error } = await migrateToLatest(db)

    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }

    const keys = [
      'AUTH_MODE',
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'INTERNAL_SERVICE_AUTH_SECRET',
      'PERSISTENCE_DRIVER',
      'MONGODB_URI',
    ]
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: mongoUri,
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

    await boot()
  }, 180_000)

  afterAll(async () => {
    await app.close()
    await mongo.close()
    await container.stop()
    restoreEnv()
  })

  const url = (path: string): string => `http://127.0.0.1:${String(port)}/api/v1/combat${path}`

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, any> }> => {
    const response = await fetch(url(path), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }

  const ticketFor = async (token: string): Promise<string> => {
    const response = await call('POST', '/realtime/tickets', token)

    expect(response.status).toBe(201)

    return response.body.ticket as string
  }

  const openRaw = async (): Promise<Client> => {
    // La URL NO lleva credenciales ni query: ni JWT ni ticket viajan en ella.
    const socketUrl = `ws://127.0.0.1:${String(port)}/api/v1/combat/realtime`

    expect(new URL(socketUrl).search).toBe('')
    expect(new URL(socketUrl).username).toBe('')

    const ws = new WebSocket(socketUrl)
    const client = new Client(ws)

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })

    return client
  }

  /** Abre un socket, obtiene un ticket del JWT y se autentica como primer mensaje. */
  const connect = async (token: string): Promise<Client> => {
    const client = await openRaw()

    client.send({ type: 'auth', ticket: await ticketFor(token) })
    await client.waitFor('auth.ok')

    return client
  }

  /** Sala 1v1 con `token-a` (creador, equipo A) y `token-b` (equipo B): queda PREPARING. */
  const preparingRoom = async (): Promise<string> => {
    const created = await call('POST', '/rooms', 'token-a', {
      mode: 'PVP',
      teamConfigs: [{ capacity: 1, initialParticipants: [{ kind: 'HUMAN' }] }, { capacity: 1 }],
      reward: { amount: 0 },
    })

    expect(created.status).toBe(201)

    const joined = await call('POST', `/rooms/${created.body.id as string}/join`, 'token-b', {})

    expect(joined.status).toBe(200)
    expect(joined.body.status).toBe('PREPARING')

    return created.body.id as string
  }

  const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  describe('flujo principal 1v1', () => {
    let roomId: string
    let a: Client
    let b: Client
    let startedBody: Record<string, any>

    beforeAll(async () => {
      roomId = await preparingRoom()
      a = await connect('token-a')
      b = await connect('token-b')

      // Antes de iniciar: ambos ven la sala preparada, sin batalla y sin ninguna accion posible.
      a.send({ type: 'resume', roomId })
      b.send({ type: 'resume', roomId })
      await a.waitFor('resume.ok')
      await b.waitFor('resume.ok')
    })

    afterAll(() => {
      a.close()
      b.close()
    })

    it('K. antes de iniciar no hay batalla ni cola: snapshot PREPARING con seq 0', () => {
      for (const client of [a, b]) {
        expect(client.ofType('snapshot')[0]).toMatchObject({
          roomId,
          seq: 0,
          status: 'PREPARING',
          battle: null,
        })
        expect(client.ofType('battleStarted')).toEqual([])
      }
    })

    it('A/L. iniciar: ambos clientes reciben battleStarted con EL MISMO mensaje, byte a byte', async () => {
      const started = await call('POST', `/rooms/${roomId}/start`, 'token-a')

      startedBody = started.body
      expect(started.status).toBe(200)

      const [eventA] = await a.waitFor('battleStarted')
      const [eventB] = await b.waitFor('battleStarted')

      expect(a.raw.find((text) => text.includes('"battleStarted"'))).toBe(
        b.raw.find((text) => text.includes('"battleStarted"')),
      )
      expect(eventA).toMatchObject({ type: 'battleStarted', seq: 1, roomId })
      expect(eventB).toEqual(eventA)
    })

    it('el evento es la misma cola que devuelve HTTP: dos participantes, sin intrusos', () => {
      const event = a.ofType('battleStarted')[0] as { battle: Record<string, any> }

      expect(event.battle).toEqual(startedBody.battle)
      expect(event.battle.turnOrder).toHaveLength(2)
      expect(
        event.battle.turnOrder.map((entry: { playerId: string }) => entry.playerId).sort(),
      ).toEqual(['sujeto-a', 'sujeto-b'])
      expect(event.battle.turnsCompleted).toBe(0)
      expect(event.battle.currentTurn.position).toBe(0)
      expect(event.battle.turnOrder[0]).toMatchObject({
        heroSubtype: expect.stringMatching(/GUERRERO_ARMAS|MAGO_FUEGO/),
      })
    })

    it('el mensaje no contiene semilla, estado del generador ni datos internos', () => {
      const raw = a.raw.join('\n')

      expect(raw).not.toMatch(/seed|semilla|mt19937|draw|jwt|ticket|hash/i)
    })

    it('B. el cliente no puede escoger el inicio ni insertar participantes: el POST ignora el cuerpo', async () => {
      const again = await call('POST', `/rooms/${roomId}/start`, 'token-b', {
        startingTeam: 'B',
        turnOrder: ['sujeto-b', 'intruso'],
      })

      expect(again.status).toBe(200)
      expect(again.body.battle).toEqual(startedBody.battle)
    })

    it('el segundo inicio es idempotente: misma cola y NINGUN battleStarted extra', async () => {
      await settle()

      expect(a.ofType('battleStarted')).toHaveLength(1)
      expect(b.ofType('battleStarted')).toHaveLength(1)
    })

    it('C. un tercer jugador no puede insertarse: no es participante (403) y no recibe el evento', async () => {
      const forbidden = await call('POST', `/rooms/${roomId}/start`, 'token-c')
      const read = await call('GET', `/rooms/${roomId}`, 'token-c')

      expect(forbidden.status).toBe(403)
      expect(read.status).toBe(403)
    })

    it('ambos clientes ven el MISMO turno actual y solo uno es el activo', () => {
      const currentA = (a.ofType('battleStarted')[0] as any).battle.currentTurn.playerId as string
      const currentB = (b.ofType('battleStarted')[0] as any).battle.currentTurn.playerId as string

      expect(currentA).toBe(currentB)
      expect(['sujeto-a', 'sujeto-b']).toContain(currentA)
    })

    it('I/J. el servidor avanza y ambos clientes se sincronizan: mismo orden, sin reroll, vuelve al primero', async () => {
      const initial = (a.ofType('battleStarted')[0] as any).battle.turnOrder as {
        playerId: string
      }[]
      const actors: string[] = []

      for (let turn = 0; turn < 5; turn += 1) {
        const room = await call('GET', `/rooms/${roomId}`, 'token-a')
        const actor = room.body.battle.currentTurn.playerId as string

        actors.push(actor)
        await complete.execute({ roomId, actorPlayerId: actor, commandId: `e2e-${String(turn)}` })
      }

      const advancedA = await a.waitFor('turnAdvanced', 5)
      const advancedB = await b.waitFor('turnAdvanced', 5)

      expect(advancedA.map((event) => event.seq)).toEqual([2, 3, 4, 5, 6])
      expect(advancedB).toEqual(advancedA)

      // El orden es el mismo en todos los eventos y en el inicial.
      for (const event of advancedA) {
        expect((event.battle as any).turnOrder).toEqual(
          (a.ofType('battleStarted')[0] as any).battle.turnOrder,
        )
      }

      // Se alterna entre los dos participantes siguiendo la cola y tras el ultimo vuelve al primero.
      expect(actors).toEqual([0, 1, 2, 3, 4].map((turn) => initial[turn % 2]?.playerId))
      expect((advancedA.at(-1)?.battle as any).round).toBe(3)
    })

    it('el estado HTTP coincide con el ultimo evento recibido', async () => {
      const room = await call('GET', `/rooms/${roomId}`, 'token-b')
      const last = b.ofType('turnAdvanced').at(-1) as { seq: number; battle: unknown }

      expect(room.body.lastSeq).toBe(last.seq)
      expect(room.body.battle).toEqual(last.battle)
    })

    it('F/D. WebSocket cortado: al reconectar con NUEVO ticket y lastSeq recibe SOLO lo que se perdio, en orden', async () => {
      const lastSeen = (b.ofType('turnAdvanced').at(-1) as { seq: number }).seq

      b.close()
      await b.waitClose()

      for (let turn = 5; turn < 8; turn += 1) {
        const room = await call('GET', `/rooms/${roomId}`, 'token-a')

        await complete.execute({
          roomId,
          actorPlayerId: room.body.battle.currentTurn.playerId as string,
          commandId: `e2e-${String(turn)}`,
        })
      }

      b = await connect('token-b')
      b.send({ type: 'resume', roomId, lastSeq: lastSeen })
      await b.waitFor('resume.ok')

      const replayed = b.ofType('turnAdvanced')

      expect(replayed.map((event) => event.seq)).toEqual([7, 8, 9])
      expect(b.ofType('snapshot')).toEqual([])
      expect(b.ofType('resume.ok')[0]).toMatchObject({ roomId, seq: 9 })
    })

    it('D. refresh (sin lastSeq): instantanea completa que coincide con el estado del servidor', async () => {
      const refreshed = await connect('token-b')

      refreshed.send({ type: 'resume', roomId })
      await refreshed.waitFor('resume.ok')

      const room = await call('GET', `/rooms/${roomId}`, 'token-b')

      expect(refreshed.ofType('snapshot')[0]).toMatchObject({ roomId, seq: 9, status: 'IN_BATTLE' })
      expect((refreshed.ofType('snapshot')[0] as any).battle).toEqual(room.body.battle)
      refreshed.close()
    })

    it('L. el estado sobrevive: tras la reconexion el cliente vuelve a recibir eventos en vivo', async () => {
      const room = await call('GET', `/rooms/${roomId}`, 'token-a')

      await complete.execute({
        roomId,
        actorPlayerId: room.body.battle.currentTurn.playerId as string,
        commandId: 'e2e-live',
      })

      const live = await b.waitFor('turnAdvanced', 4)

      expect(live.at(-1)?.seq).toBe(10)
      expect((await a.waitFor('turnAdvanced', 9)).at(-1)?.seq).toBe(10)
    })

    it('un commandId duplicado no avanza dos veces ni difunde otro evento', async () => {
      const before = await call('GET', `/rooms/${roomId}`, 'token-a')

      await complete.execute({
        roomId,
        actorPlayerId: before.body.battle.currentTurn.playerId as string,
        commandId: 'e2e-live',
      })
      await settle()

      const after = await call('GET', `/rooms/${roomId}`, 'token-a')

      expect(after.body.lastSeq).toBe(before.body.lastSeq)
      expect(after.body.battle.turnsCompleted).toBe(before.body.battle.turnsCompleted)
    })

    it('el documento de MongoDB guarda batalla, bitacora con seq sin huecos y comandos procesados', async () => {
      const document = await db
        .collection<Record<string, any>>('battle-rooms')
        .findOne({ _id: roomId as never })

      expect(document?.status).toBe('IN_BATTLE')
      expect(document?.battle.turnOrder).toHaveLength(2)
      expect(document?.events.map((event: { seq: number }) => event.seq)).toEqual(
        Array.from({ length: 10 }, (_, index) => index + 1),
      )
      expect(document?.handledCommands.length).toBe(9)
      expect(JSON.stringify(document)).not.toMatch(/seed|semilla|mt19937/i)
    })
  })

  describe('seguridad del WebSocket', () => {
    it('G. un ticket usado no se puede reutilizar: la segunda conexion se cierra con 4401', async () => {
      const ticket = await ticketFor('token-a')
      const first = await openRaw()
      const second = await openRaw()

      first.send({ type: 'auth', ticket })
      await first.waitFor('auth.ok')
      second.send({ type: 'auth', ticket })

      expect(await second.waitClose()).toBe(4401)
      first.close()
    })

    it('el esquema antiguo con JWT en el primer mensaje ya no autentica: 4401', async () => {
      const client = await openRaw()

      client.send({ type: 'auth', token: 'token-a' })

      expect(await client.waitClose()).toBe(4401)
    })

    it('sin ticket en 5 segundos la conexion se cierra con 4401', async () => {
      const client = await openRaw()

      expect(await client.waitClose(9_000)).toBe(4401)
    }, 15_000)

    it('el sub de la conexion es el del ticket: un mensaje NO puede declarar otro jugador', async () => {
      const roomId = await preparingRoom()
      const c = await connect('token-c')

      c.send({ type: 'resume', roomId, playerId: 'sujeto-a', sub: 'sujeto-a' })

      expect((await c.waitFor('command.rejected'))[0]).toEqual({
        type: 'command.rejected',
        code: 'NOT_A_PARTICIPANT',
      })
      c.close()
    })

    it('H. resume de una sala ajena se rechaza y ese cliente no recibe los eventos de la batalla', async () => {
      const roomId = await preparingRoom()
      const a = await connect('token-a')
      const c = await connect('token-c')

      a.send({ type: 'resume', roomId })
      c.send({ type: 'resume', roomId })
      await a.waitFor('resume.ok')
      await c.waitFor('command.rejected')
      await call('POST', `/rooms/${roomId}/start`, 'token-a')
      await a.waitFor('battleStarted')
      await settle()

      expect(c.ofType('battleStarted')).toEqual([])
      expect(c.ofType('resume.ok')).toEqual([])
      a.close()
      c.close()
    })

    it('un mensaje mayor de 16 KiB cierra la conexion (limite de ADR-020)', async () => {
      const client = await connect('token-a')

      client.send({ type: 'subscribe', roomId: 'x'.repeat(20_000) })

      expect(await client.waitClose()).toBe(1009)
    })

    it('ticket: solo con testimonio valido y solo del propio sub', async () => {
      expect((await call('POST', '/realtime/tickets', 'invalido')).status).toBe(401)
    })
  })

  describe('concurrencia y persistencia reales', () => {
    it('dos inicios simultaneos del propietario contra MongoDB producen UNA cola y UN battleStarted', async () => {
      const roomId = await preparingRoom()
      const a = await connect('token-a')
      const b = await connect('token-b')

      a.send({ type: 'resume', roomId })
      b.send({ type: 'resume', roomId })
      await a.waitFor('resume.ok')
      await b.waitFor('resume.ok')

      const [first, second] = await Promise.all([
        call('POST', `/rooms/${roomId}/start`, 'token-a'),
        call('POST', `/rooms/${roomId}/start`, 'token-a'),
      ])

      await a.waitFor('battleStarted')
      await settle(400)

      expect([first.status, second.status]).toEqual([200, 200])
      expect(first.body.battle.turnOrder).toEqual(second.body.battle.turnOrder)
      expect(a.ofType('battleStarted')).toHaveLength(1)
      expect(b.ofType('battleStarted')).toHaveLength(1)
      a.close()
      b.close()
    })

    it('resume concurrente: un evento persistido y publicado ENTRE la lectura y la suscripcion NO se pierde', async () => {
      const roomId = await preparingRoom()
      const started = await call('POST', `/rooms/${roomId}/start`, 'token-a')
      const first = started.body.battle.currentTurn.playerId as string

      await complete.execute({ roomId, actorPlayerId: first, commandId: 'carrera-1' }) // seq 2

      const beforeWindow = await call('GET', `/rooms/${roomId}`, 'token-a')
      const second = beforeWindow.body.battle.currentTurn.playerId as string
      const b = await connect('token-b')

      // El resume lee el estado REAL de MongoDB (seq 2) y se detiene ANTES de quedar
      // suscrito, hasta que este test lo libera.
      let openGate: () => void = () => undefined
      let markRead: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
      const read = new Promise<void>((resolve) => {
        markRead = resolve
      })
      const original = resume.execute.bind(resume)
      const spy = jest.spyOn(resume, 'execute').mockImplementationOnce(async (...args) => {
        const result = await original(...args)

        markRead()
        await gate

        return result
      })

      b.send({ type: 'resume', roomId, lastSeq: 1 })
      await read

      // EN LA VENTANA: otro request persiste en MongoDB y publica el seq 3.
      await complete.execute({ roomId, actorPlayerId: second, commandId: 'carrera-2' })
      openGate()
      await b.waitFor('resume.ok')
      spy.mockRestore()

      expect(b.ofType('turnAdvanced').map((event) => event.seq)).toEqual([2, 3])
      expect(b.ofType('resume.ok')[0]).toMatchObject({ roomId, seq: 3 })

      // MongoDB confirma que el ultimo seq es 3: el cliente termino con el estado completo.
      const persisted = await call('GET', `/rooms/${roomId}`, 'token-b')

      expect(persisted.body.lastSeq).toBe(3)
      expect(persisted.body.battle).toEqual((b.ofType('turnAdvanced').at(-1) as any).battle)

      // Y a partir de aqui los eventos siguen llegando en caliente, en orden.
      await complete.execute({
        roomId,
        actorPlayerId: persisted.body.battle.currentTurn.playerId as string,
        commandId: 'carrera-3',
      })
      await b.waitFor('turnAdvanced', 3)

      expect(b.ofType('turnAdvanced').map((event) => event.seq)).toEqual([2, 3, 4])
      b.close()
    }, 30_000)

    it('el estado sobrevive a un REINICIO de Combat: misma cola, mismo turno y resume funcional', async () => {
      const roomId = await preparingRoom()
      const started = await call('POST', `/rooms/${roomId}/start`, 'token-a')

      await complete.execute({
        roomId,
        actorPlayerId: started.body.battle.currentTurn.playerId as string,
        commandId: 'antes-del-reinicio',
      })
      const before = await call('GET', `/rooms/${roomId}`, 'token-a')

      await app.close()
      await boot()

      const after = await call('GET', `/rooms/${roomId}`, 'token-b')

      expect(after.status).toBe(200)
      expect(after.body.battle).toEqual(before.body.battle)
      expect(after.body.lastSeq).toBe(2)

      const client = await connect('token-b')

      client.send({ type: 'resume', roomId, lastSeq: 1 })
      await client.waitFor('resume.ok')

      expect(client.ofType('turnAdvanced').map((event) => event.seq)).toEqual([2])

      // Y el turno sigue avanzando desde donde quedo (el commandId anterior ya esta procesado).
      const actor = after.body.battle.currentTurn.playerId as string

      await complete.execute({ roomId, actorPlayerId: actor, commandId: 'antes-del-reinicio' })
      await settle()

      expect((await call('GET', `/rooms/${roomId}`, 'token-a')).body.lastSeq).toBe(2)
      client.close()
    }, 30_000)

    it('el validador $jsonSchema de la migracion 005 rechaza una bitacora con un tipo de evento desconocido', async () => {
      const roomId = await preparingRoom()
      const collection = db.collection<Record<string, any>>('battle-rooms')
      const document = await collection.findOne({ _id: roomId as never })

      await expect(
        collection.updateOne(
          { _id: roomId as never },
          {
            $set: {
              status: 'IN_BATTLE',
              battle:
                document?.teams === undefined
                  ? null
                  : { startedAt: new Date(), turnOrder: [], turnsCompleted: 0 },
              events: [{ seq: 1, type: 'tipo-inventado', occurredAt: new Date(), payload: {} }],
            },
          },
        ),
      ).rejects.toBeInstanceOf(MongoServerError)
    })
  })
})
