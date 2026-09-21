import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { WebSocket } from 'ws'

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
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { equippedHeroFixture } from '../fixtures/equipped-hero'

/**
 * Chat de Jugar Online sobre el transporte REAL (HU-13, RF-13): el modulo
 * completo de Nest con el adaptador `ws`, clientes `ws` de verdad y las rutas
 * HTTP de salas. Es la unica prueba donde los mensajes viajan por una conexion
 * WebSocket: comprueba lo que un socket falso no puede (tramas reales, orden de
 * llegada de los mensajes seguidos, tamano maximo, cierre por el servidor).
 * La conexion se autentica como en produccion (HU-17, ADR-020): un ticket de un
 * solo uso pedido por HTTP con el JWT, enviado como primer mensaje.
 *
 * Persistencia en memoria: el adaptador de MongoDB lo prueba `test/db`.
 */
const TOKENS = ['ana', 'beto', 'carla', 'dora', 'creador'] as const

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = Object.fromEntries(
  TOKENS.map((name) => [
    `token-${name}`,
    { subject: `sujeto-${name}`, email: null, roles: new Set([Role.Player]) },
  ]),
)

const stubVerifier: TokenVerifierPort = {
  verify: (token) => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const stubAccountProfiles: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `Nombre de ${subject}`, avatarUrl: null }),
}

const stubEquippedHeroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(equippedHeroFixture({ playerId, heroId: `heroe-de-${playerId}` })),
}

const withEnv = (values: Record<string, string>): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

type Frame = Record<string, unknown>

/** Cliente WebSocket que acumula todo lo recibido y permite esperar una trama concreta. */
class Client {
  readonly frames: Frame[] = []
  closed: { code: number; reason: string } | null = null
  private readonly waiters: (() => void)[] = []

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => {
      this.frames.push(JSON.parse(data.toString()) as Frame)
      this.notify()
    })
    socket.on('close', (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString() }
      this.notify()
    })
  }

  static async connect(url: string): Promise<Client> {
    const socket = new WebSocket(url)

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve()
      })
      socket.once('error', reject)
    })

    return new Client(socket)
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  of(type: string): Frame[] {
    return this.frames.filter((frame) => frame.type === type)
  }

  types(): unknown[] {
    return this.frames.map((frame) => frame.type)
  }

  async waitUntil(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs

    while (!condition()) {
      const remaining = deadline - Date.now()

      if (remaining <= 0) {
        throw new Error(
          `Tiempo agotado esperando ${what}. Recibido: ${JSON.stringify(this.frames)}; cierre: ${JSON.stringify(this.closed)}`,
        )
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 25))

        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  waitForType(type: string, count = 1): Promise<void> {
    return this.waitUntil(() => this.of(type).length >= count, `${String(count)} x ${type}`)
  }

  waitForClose(): Promise<void> {
    return this.waitUntil(() => this.closed !== null, 'el cierre de la conexion')
  }

  /** Espera un instante para comprobar que NO llega nada (ausencia de mensajes). */
  static quiet(ms = 150): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  close(): void {
    this.socket.close()
  }

  private notify(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter()
    }
  }
}

describe('chat de Jugar Online sobre WebSocket real (HU-13)', () => {
  let app: INestApplication
  let restore: () => void
  let url: string
  const clients: Client[] = []
  let cmd = 0

  const commandId = (): string => {
    cmd += 1

    return `00000000-0000-4000-8000-${String(900_000 + cmd).padStart(12, '0')}`
  }

  const connect = async (): Promise<Client> => {
    const client = await Client.connect(url)

    clients.push(client)

    return client
  }

  /** Conecta, se autentica y suscribe SIN esperar entre mensajes (como hace Web). */
  const enter = async (
    name: (typeof TOKENS)[number],
    channel: Record<string, unknown>,
  ): Promise<Client> => {
    const client = await connect()

    client.send(await authMessage(name))
    client.send({ type: 'chat.subscribe', ...channel })
    await client.waitForType('chat.subscribed')

    return client
  }

  const authed = (name: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer token-${name}`)

  /** Ticket de un solo uso de `name`, pedido por HTTP con su JWT (nadie lo pide para otro). */
  const ticketFor = async (name: string): Promise<string> => {
    const response = await authed(name)(
      request(app.getHttpServer()).post('/api/v1/combat/realtime/tickets'),
    )

    expect(response.status).toBe(201)

    return (response.body as { ticket: string }).ticket
  }

  /** Primer mensaje del socket. El ticket se pide ANTES: el envio de los mensajes sigue siendo seguido. */
  const authMessage = async (name: string): Promise<{ type: string; ticket: string }> => ({
    type: 'auth',
    ticket: await ticketFor(name),
  })

  const createRoomOverHttp = async (creator = 'creador'): Promise<string> => {
    const response = await authed(creator)(
      request(app.getHttpServer())
        .post('/api/v1/combat/rooms')
        .send({
          mode: 'PVP',
          teamConfigs: [{ capacity: 2 }, { capacity: 2 }],
          reward: { amount: 0 },
        }),
    )

    expect(response.status).toBe(201)

    return (response.body as { id: string }).id
  }

  const joinOverHttp = async (roomId: string, name: string): Promise<void> => {
    const response = await authed(name)(
      request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/join`).send({}),
    )

    expect(response.status).toBe(200)
  }

  beforeAll(async () => {
    restore = withEnv({
      NODE_ENV: 'test',
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',
      PERSISTENCE_DRIVER: 'memory',
      // Sin limite practico de frecuencia: estas pruebas no ejercitan el limitador.
      CHAT_RATE_LIMIT_MESSAGES: '100',
    })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(stubAccountProfiles)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(stubEquippedHeroes)
      .compile()

    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.listen(0, '127.0.0.1')

    const address = app.getHttpServer().address() as { port: number }

    url = `ws://127.0.0.1:${String(address.port)}/api/v1/combat/realtime`
  })

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close()
    }
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  describe('mensajes seguidos sobre el transporte real', () => {
    it('auth, chat.subscribe y chat.send en el MISMO instante funcionan y llegan en orden', async () => {
      const client = await connect()
      const id = commandId()

      client.send(await authMessage('ana'))
      client.send({ type: 'chat.subscribe', channel: 'lobby' })
      client.send({ type: 'chat.send', channel: 'lobby', commandId: id, text: 'hola' })

      await client.waitForType('chat.accepted')

      expect(client.closed).toBeNull()
      expect(client.types()).toEqual([
        'auth.ok',
        'chat.subscribed',
        'chat.message',
        'chat.accepted',
      ])
    })

    it('el subscribe de HU-15.2 (battle-room.updated) tambien funciona pegado al auth', async () => {
      const roomId = await createRoomOverHttp()
      const client = await connect()

      client.send(await authMessage('ana'))
      client.send({ type: 'subscribe', roomId })

      await client.waitForType('subscribe.ok')

      expect(client.closed).toBeNull()
      expect(client.types()).toEqual(['auth.ok', 'subscribe.ok'])
    })
  })

  describe('autenticacion', () => {
    it('chat.subscribe sin autenticar cierra con 4401', async () => {
      const client = await connect()

      client.send({ type: 'chat.subscribe', channel: 'lobby' })
      await client.waitForClose()

      expect(client.closed?.code).toBe(4401)
    })

    it('el esquema anterior (JWT en el primer mensaje) ya no autentica: 4401', async () => {
      const client = await connect()

      client.send({ type: 'auth', token: 'token-ana' })
      client.send({ type: 'chat.subscribe', channel: 'lobby' })
      await client.waitForClose()

      expect(client.closed?.code).toBe(4401)
      expect(client.of('chat.subscribed')).toHaveLength(0)
    })

    it('un ticket ya usado no vuelve a autenticar: 4401 y no llega a suscribirse', async () => {
      const ticket = await ticketFor('ana')
      const first = await connect()

      first.send({ type: 'auth', ticket })
      await first.waitForType('auth.ok')

      const second = await connect()

      second.send({ type: 'auth', ticket })
      second.send({ type: 'chat.subscribe', channel: 'lobby' })
      await second.waitForClose()

      expect(second.closed?.code).toBe(4401)
      expect(second.of('chat.subscribed')).toHaveLength(0)
    })

    it('un ticket invalido cierra con 4401 y no llega a suscribirse', async () => {
      const client = await connect()

      client.send({ type: 'auth', ticket: 'ticket-inventado' })
      client.send({ type: 'chat.subscribe', channel: 'lobby' })
      await client.waitForClose()

      expect(client.closed?.code).toBe(4401)
      expect(client.of('chat.subscribed')).toHaveLength(0)
    })

    it('un mensaje que no es JSON cierra con 4400', async () => {
      const client = await connect()

      client.socket.send('esto no es json')
      await client.waitForClose()

      expect(client.closed?.code).toBe(4400)
    })
  })

  describe('CA-01: lobby', () => {
    it('un mensaje escrito por un jugador llega en tiempo real a los demas del lobby', async () => {
      const ana = await enter('ana', { channel: 'lobby' })
      const beto = await enter('beto', { channel: 'lobby' })
      const carla = await enter('carla', { channel: 'lobby' })

      ana.send({
        type: 'chat.send',
        channel: 'lobby',
        commandId: commandId(),
        text: 'quien juega?',
      })

      await Promise.all([ana, beto, carla].map((c) => c.waitForType('chat.message')))

      for (const client of [ana, beto, carla]) {
        expect(client.of('chat.message')).toHaveLength(1)
        expect(client.of('chat.message')[0]).toMatchObject({
          channel: 'lobby',
          text: 'quien juega?',
          sender: { displayName: 'Nombre de sujeto-ana' },
        })
      }
    })

    it('un jugador que entra despues recibe el historial reciente', async () => {
      const ana = await enter('ana', { channel: 'lobby' })
      const before = ana.of('chat.message').length

      ana.send({ type: 'chat.send', channel: 'lobby', commandId: commandId(), text: 'primero' })
      ana.send({ type: 'chat.send', channel: 'lobby', commandId: commandId(), text: 'segundo' })
      await ana.waitForType('chat.message', before + 2)

      const late = await enter('beto', { channel: 'lobby' })
      const subscribed = late.of('chat.subscribed')[0] as { messages: { text: string }[] }

      expect(subscribed.messages.slice(-2).map((m) => m.text)).toEqual(['primero', 'segundo'])
    })
  })

  describe('CA-01: sala', () => {
    it('un mensaje de sala llega a los participantes de esa sala y a nadie mas', async () => {
      const roomA = await createRoomOverHttp()
      const roomB = await createRoomOverHttp()
      await joinOverHttp(roomA, 'ana')
      await joinOverHttp(roomA, 'beto')
      await joinOverHttp(roomB, 'carla')

      const ana = await enter('ana', { channel: 'room', roomId: roomA })
      const beto = await enter('beto', { channel: 'room', roomId: roomA })
      const carla = await enter('carla', { channel: 'room', roomId: roomB })
      const dora = await enter('dora', { channel: 'lobby' })

      ana.send({
        type: 'chat.send',
        channel: 'room',
        roomId: roomA,
        commandId: commandId(),
        text: 'listos?',
      })
      await Promise.all([ana, beto].map((c) => c.waitForType('chat.message')))
      await Client.quiet()

      expect(ana.of('chat.message')[0]).toMatchObject({
        channel: 'room',
        roomId: roomA,
        text: 'listos?',
      })
      expect(beto.of('chat.message')).toHaveLength(1)
      // Aislamiento (RF-13): ni la otra sala ni el lobby reciben nada.
      expect(carla.of('chat.message')).toHaveLength(0)
      expect(dora.of('chat.message').filter((f) => f.text === 'listos?')).toHaveLength(0)
    })

    it('un jugador que no es de la sala no puede suscribirse a su chat', async () => {
      const roomId = await createRoomOverHttp()
      await joinOverHttp(roomId, 'ana')
      const intruso = await connect()

      intruso.send(await authMessage('dora'))
      intruso.send({ type: 'chat.subscribe', channel: 'room', roomId })
      await intruso.waitForType('command.rejected')

      expect(intruso.of('command.rejected')[0]).toMatchObject({
        command: 'chat.subscribe',
        code: 'NOT_A_PARTICIPANT',
      })
      expect(intruso.of('chat.subscribed')).toHaveLength(0)
    })

    it('quien abandona la sala por HTTP deja de recibir su chat y se le avisa', async () => {
      const roomId = await createRoomOverHttp()
      await joinOverHttp(roomId, 'ana')
      await joinOverHttp(roomId, 'beto')
      const ana = await enter('ana', { channel: 'room', roomId })
      const beto = await enter('beto', { channel: 'room', roomId })

      const response = await authed('ana')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/leave`).send({}),
      )
      expect(response.status).toBe(200)
      await ana.waitForType('chat.unsubscribed')

      expect(ana.of('chat.unsubscribed')[0]).toMatchObject({
        channel: 'room',
        roomId,
        reason: 'NOT_A_PARTICIPANT',
      })

      beto.send({
        type: 'chat.send',
        channel: 'room',
        roomId,
        commandId: commandId(),
        text: 'ya no esta ana',
      })
      await beto.waitForType('chat.message')
      await Client.quiet()

      expect(ana.of('chat.message')).toHaveLength(0)
    })

    it('al cancelar la sala por HTTP se cierra su chat para todos los suscritos', async () => {
      const roomId = await createRoomOverHttp('creador')
      await joinOverHttp(roomId, 'ana')
      const ana = await enter('ana', { channel: 'room', roomId })

      const response = await authed('creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/cancel`).send({}),
      )
      expect(response.status).toBe(200)
      await ana.waitForType('chat.unsubscribed')

      expect(ana.of('chat.unsubscribed')[0]).toMatchObject({ reason: 'ROOM_NOT_ACTIVE' })
    })
  })

  describe('procesado una sola vez', () => {
    it('el mismo comando enviado dos veces se difunde UNA sola vez', async () => {
      const ana = await enter('ana', { channel: 'lobby' })
      const beto = await enter('beto', { channel: 'lobby' })
      const before = beto.of('chat.message').length
      const id = commandId()

      ana.send({ type: 'chat.send', channel: 'lobby', commandId: id, text: 'una sola vez' })
      ana.send({ type: 'chat.send', channel: 'lobby', commandId: id, text: 'una sola vez' })
      await ana.waitForType('chat.accepted', 2)
      await Client.quiet()

      expect(beto.of('chat.message').length - before).toBe(1)
      const accepts = ana.of('chat.accepted').slice(-2)

      expect(new Set(accepts.map((a) => a.seq)).size).toBe(1)
      expect(accepts.map((a) => a.duplicate).sort()).toEqual([false, true])
    })
  })

  describe('orden y recuperacion', () => {
    it('muchos mensajes seguidos llegan a todos en orden de seq, sin huecos ni repetidos', async () => {
      const ana = await enter('ana', { channel: 'lobby' })
      const beto = await enter('beto', { channel: 'lobby' })
      const start = beto.of('chat.message').length

      for (let i = 0; i < 30; i += 1) {
        ana.send({
          type: 'chat.send',
          channel: 'lobby',
          commandId: commandId(),
          text: `m${String(i)}`,
        })
      }
      await beto.waitForType('chat.message', start + 30)

      const seqs = beto
        .of('chat.message')
        .slice(start)
        .map((f) => f.seq as number)

      expect(seqs).toEqual([...Array(30).keys()].map((i) => seqs[0]! + i))
    })

    it('quien se reconecta con su lastSeq recupera exactamente lo que le falto', async () => {
      const ana = await enter('ana', { channel: 'lobby' })
      const first = await enter('beto', { channel: 'lobby' })

      ana.send({
        type: 'chat.send',
        channel: 'lobby',
        commandId: commandId(),
        text: 'antes de caer',
      })
      await first.waitForType('chat.message')
      const lastSeen = first.of('chat.message').at(-1)?.seq as number

      first.close()
      await first.waitForClose()

      for (const text of ['mientras', 'estaba', 'caido']) {
        ana.send({ type: 'chat.send', channel: 'lobby', commandId: commandId(), text })
      }
      await ana.waitForType('chat.accepted', 4)

      const second = await connect()
      second.send(await authMessage('beto'))
      second.send({ type: 'chat.subscribe', channel: 'lobby', lastSeq: lastSeen })
      await second.waitForType('chat.subscribed')

      const frame = second.of('chat.subscribed')[0] as { messages: { text: string; seq: number }[] }

      expect(frame.messages.map((m) => m.text)).toEqual(['mientras', 'estaba', 'caido'])
      expect(frame.messages.map((m) => m.seq)).toEqual([lastSeen + 1, lastSeen + 2, lastSeen + 3])
    })
  })

  describe('limites del transporte', () => {
    it('un mensaje entrante de mas de 16 KiB cierra la conexion (1009)', async () => {
      const client = await connect()

      client.send(await authMessage('ana'))
      client.socket.send(
        JSON.stringify({
          type: 'chat.subscribe',
          channel: 'lobby',
          padding: 'x'.repeat(17 * 1024),
        }),
      )
      await client.waitForClose()

      expect(client.closed?.code).toBe(1009)
    })

    it('un mensaje de chat pegado al maximo del texto (500) se acepta y uno de 501 se rechaza', async () => {
      const ana = await enter('ana', { channel: 'lobby' })

      ana.send({
        type: 'chat.send',
        channel: 'lobby',
        commandId: commandId(),
        text: 'a'.repeat(500),
      })
      await ana.waitForType('chat.accepted')

      ana.send({
        type: 'chat.send',
        channel: 'lobby',
        commandId: commandId(),
        text: 'a'.repeat(501),
      })
      await ana.waitForType('command.rejected')

      expect(ana.of('command.rejected').at(-1)).toMatchObject({
        code: 'MESSAGE_TOO_LONG',
        maxLength: 500,
      })
    })

    it('el texto se entrega como texto: no se altera ni se interpreta como HTML', async () => {
      const ana = await enter('ana', { channel: 'lobby' })
      const payload = '<img src=x onerror=alert(1)> & "comillas"'

      ana.send({ type: 'chat.send', channel: 'lobby', commandId: commandId(), text: payload })
      await ana.waitForType('chat.message')

      expect(ana.of('chat.message').at(-1)?.text).toBe(payload)
    })
  })
})
