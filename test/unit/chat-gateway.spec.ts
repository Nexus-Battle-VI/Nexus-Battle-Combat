import 'reflect-metadata'

import { BattleRoomRealtimeGateway } from '../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import type { ChatRealtimeHandler } from '../../src/adapters/inbound/ws/ChatRealtimeHandler'
import {
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import {
  buildChatHarness,
  createRoom,
  joinRoom,
  leaveRoom,
  recordingLogger,
  uuid,
} from '../fixtures/chat-harness'
import { FakeSocket, flush } from '../fixtures/fake-socket'

/**
 * El gateway con el chat (HU-13). Integra: autenticacion, cola secuencial por
 * conexion, enrutado de `chat.*`, expulsion al cambiar la sala y latido.
 */
const IDENTITY: VerifiedIdentity = { subject: 'ana', email: null, roles: new Set() }

/** Verificador que tarda una macrotarea, como la primera descarga del JWKS de Cognito. */
const slowVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> =>
    token === 'ok'
      ? new Promise((resolve) => {
          setTimeout(() => {
            resolve(IDENTITY)
          }, 20)
        })
      : Promise.reject(new TokenVerificationError()),
}

const instantVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> =>
    token === 'ok' ? Promise.resolve(IDENTITY) : Promise.reject(new TokenVerificationError()),
}

describe('BattleRoomRealtimeGateway con chat (HU-13)', () => {
  const ROOM = uuid(1)
  const lobby = { channel: 'lobby' } as const
  let cmd = 0
  const commandId = (): string => {
    cmd += 1

    return uuid(80_000 + cmd)
  }

  const build = (verifier: TokenVerifierPort = instantVerifier) => {
    const harness = buildChatHarness()
    const { logger, logs } = recordingLogger()
    const gateway = new BattleRoomRealtimeGateway(verifier, harness.rooms, logger, harness.handler)

    return { harness, gateway, logs }
  }

  describe('carrera auth + subscribe (defecto medido en develop)', () => {
    it.each([
      ['verificador instantaneo (JWKS ya en cache)', instantVerifier],
      ['verificador lento (primera descarga del JWKS)', slowVerifier],
    ])('auth y subscribe enviados SEGUIDOS: subscribe funciona - %s', async (_label, verifier) => {
      const { harness, gateway } = build(verifier)
      await createRoom(harness.rooms, ROOM, 'creador')
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', token: 'ok' })
      socket.emit({ type: 'subscribe', roomId: ROOM })
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(socket.closeCalls).toEqual([])
      expect(socket.frames().map((f) => f.type)).toEqual(['auth.ok', 'subscribe.ok'])
    })

    it('auth + chat.subscribe + chat.send seguidos se atienden EN ORDEN', async () => {
      const { gateway } = build(slowVerifier)
      const socket = new FakeSocket()
      const id = commandId()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', token: 'ok' })
      socket.emit({ type: 'chat.subscribe', ...lobby })
      socket.emit({ type: 'chat.send', ...lobby, commandId: id, text: 'hola' })
      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(socket.closeCalls).toEqual([])
      expect(socket.frames().map((f) => f.type)).toEqual([
        'auth.ok',
        'chat.subscribed',
        'chat.message',
        'chat.accepted',
      ])
    })

    it('conexiones distintas no se esperan entre si', async () => {
      const { gateway } = build(slowVerifier)
      const slow = new FakeSocket()
      const fast = new FakeSocket()

      gateway.handleConnection(slow)
      slow.emit({ type: 'auth', token: 'ok' })
      gateway.handleConnection(fast)
      fast.emit({ type: 'auth', token: 'malo' })
      await flush()

      // La rapida ya fue rechazada aunque la lenta siga verificando.
      expect(fast.closeCalls[0]?.code).toBe(4401)
      expect(slow.closeCalls).toEqual([])
    })
  })

  describe('chat sin autenticar y tipos desconocidos', () => {
    it.each(['chat.subscribe', 'chat.send', 'chat.unsubscribe'])(
      '%s antes de autenticar cierra con 4401 y no toca el chat',
      async (type) => {
        const { harness, gateway } = build()
        const socket = new FakeSocket()

        gateway.handleConnection(socket)
        socket.emit({ type, ...lobby, commandId: commandId(), text: 'hola' })
        await flush()

        expect(socket.closeCalls[0]).toEqual({ code: 4401, reason: 'no_autenticado' })
        expect(harness.handler.subscriberCount('lobby')).toBe(0)
      },
    )

    it('un chat.* que no existe cierra con 4400', async () => {
      const { gateway } = build()
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', token: 'ok' })
      socket.emit({ type: 'chat.editar', ...lobby })
      await flush()

      expect(socket.closeCalls[0]).toEqual({ code: 4400, reason: 'tipo_no_reconocido' })
    })

    it('un token invalido cierra con 4401 y los mensajes en cola no se atienden', async () => {
      const { harness, gateway } = build()
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', token: 'malo' })
      socket.emit({ type: 'chat.subscribe', ...lobby })
      await flush()

      expect(socket.closeCalls[0]?.code).toBe(4401)
      expect(harness.handler.subscriberCount('lobby')).toBe(0)
    })
  })

  describe('limite de mensajes en espera por conexion', () => {
    it('frontera: 64 en espera se aceptan y el 65 cierra con 1008', () => {
      // La verificacion nunca termina: `auth` ocupa la cola y todo lo demas espera.
      const stuck: TokenVerifierPort = { verify: () => new Promise(() => undefined) }
      const { gateway } = build(stuck)
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', token: 'ok' })

      for (let i = 0; i < 64; i += 1) {
        socket.emit({ type: 'chat.subscribe', ...lobby })
      }

      expect(socket.closeCalls).toEqual([])

      socket.emit({ type: 'chat.subscribe', ...lobby })

      expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'demasiados_mensajes' }])
    })
  })

  describe('el chat reacciona a los cambios de la sala', () => {
    it('notifyRoomUpdated expulsa del chat a quien salio de la sala', async () => {
      const { harness, gateway } = build()
      await createRoom(harness.rooms, ROOM, 'creador')
      await joinRoom(harness.rooms, ROOM, 'ana', 'Ana')
      await joinRoom(harness.rooms, ROOM, 'beto', 'Beto')
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', token: 'ok' })
      socket.emit({ type: 'chat.subscribe', channel: 'room', roomId: ROOM })
      await flush()
      expect(harness.handler.subscriberCount(`room:${ROOM}`)).toBe(1)

      await leaveRoom(harness.rooms, ROOM, 'ana')
      gateway.notifyRoomUpdated({ roomId: ROOM, status: 'WAITING_FOR_PLAYERS', version: 4 })
      await flush()

      expect(socket.framesOfType('chat.unsubscribed')).toEqual([
        { type: 'chat.unsubscribed', channel: 'room', roomId: ROOM, reason: 'NOT_A_PARTICIPANT' },
      ])
      expect(harness.handler.subscriberCount(`room:${ROOM}`)).toBe(0)
    })

    it('un fallo del chat al revalidar se registra y NO rompe notifyRoomUpdated', async () => {
      const { logger, logs } = recordingLogger()
      const harness = buildChatHarness()
      const failingChat = {
        onRoomUpdated: () => Promise.reject(new Error('base caida')),
        onDisconnect: () => undefined,
        handle: () => Promise.resolve(),
      } as unknown as ChatRealtimeHandler
      const gateway = new BattleRoomRealtimeGateway(
        instantVerifier,
        harness.rooms,
        logger,
        failingChat,
      )

      expect(() => {
        gateway.notifyRoomUpdated({ roomId: ROOM, status: 'PREPARING', version: 2 })
      }).not.toThrow()
      await flush()

      expect(logs.some((l) => l.message === 'chat_actualizacion_de_sala_fallo')).toBe(true)
    })

    it('al cerrarse la conexion el chat la da de baja', async () => {
      const { harness, gateway } = build()
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', token: 'ok' })
      socket.emit({ type: 'chat.subscribe', ...lobby })
      await flush()
      expect(harness.handler.subscriberCount('lobby')).toBe(1)

      socket.close()

      expect(harness.handler.subscriberCount('lobby')).toBe(0)
    })
  })

  describe('latido (ADR-020: ping cada 25 s, cierre si no hay pong)', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    const buildWithHeartbeat = (intervalMs: number) => {
      const harness = buildChatHarness()
      const { logger } = recordingLogger()

      return new BattleRoomRealtimeGateway(
        instantVerifier,
        harness.rooms,
        logger,
        harness.handler,
        intervalMs,
      )
    }

    it('envia un ping en cada periodo', () => {
      const gateway = buildWithHeartbeat(1_000)
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      jest.advanceTimersByTime(999)
      expect(socket.pingCount).toBe(0)

      jest.advanceTimersByTime(1)
      expect(socket.pingCount).toBe(1)

      gateway.onModuleDestroy()
    })

    it('una conexion que responde con pong sigue abierta', () => {
      const gateway = buildWithHeartbeat(1_000)
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      jest.advanceTimersByTime(1_000)
      socket.emitPong()
      jest.advanceTimersByTime(1_000)
      socket.emitPong()
      jest.advanceTimersByTime(1_000)

      expect(socket.terminated).toBe(false)
      expect(socket.pingCount).toBe(3)

      gateway.onModuleDestroy()
    })

    it('la que NO responde al ping anterior se termina en el periodo siguiente', () => {
      const gateway = buildWithHeartbeat(1_000)
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      jest.advanceTimersByTime(1_000) // primer ping
      expect(socket.terminated).toBe(false)

      jest.advanceTimersByTime(1_000) // sin pong: se corta
      expect(socket.terminated).toBe(true)

      gateway.onModuleDestroy()
    })

    it('la conexion terminada se da de baja del chat (queda desconectada, no suscrita)', async () => {
      jest.useRealTimers()
      const harness = buildChatHarness()
      const { logger } = recordingLogger()
      const gateway = new BattleRoomRealtimeGateway(
        instantVerifier,
        harness.rooms,
        logger,
        harness.handler,
        30,
      )
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', token: 'ok' })
      socket.emit({ type: 'chat.subscribe', ...lobby })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(harness.handler.subscriberCount('lobby')).toBe(1)

      // Sin pong: el segundo periodo la termina.
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(socket.terminated).toBe(true)
      expect(harness.handler.subscriberCount('lobby')).toBe(0)

      gateway.onModuleDestroy()
    })

    it('cada conexion se evalua por separado', () => {
      const gateway = buildWithHeartbeat(1_000)
      const alive = new FakeSocket()
      const dead = new FakeSocket()

      gateway.handleConnection(alive)
      gateway.handleConnection(dead)
      jest.advanceTimersByTime(1_000)
      alive.emitPong()
      jest.advanceTimersByTime(1_000)

      expect(alive.terminated).toBe(false)
      expect(dead.terminated).toBe(true)

      gateway.onModuleDestroy()
    })

    it('onModuleDestroy detiene el latido', () => {
      const gateway = buildWithHeartbeat(1_000)
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      gateway.onModuleDestroy()
      jest.advanceTimersByTime(10_000)

      expect(socket.pingCount).toBe(0)
    })

    it('un unico temporizador para todas las conexiones', () => {
      const gateway = buildWithHeartbeat(1_000)

      gateway.handleConnection(new FakeSocket())
      gateway.handleConnection(new FakeSocket())
      gateway.handleConnection(new FakeSocket())

      expect(jest.getTimerCount()).toBe(1 + 3) // 1 latido + 3 plazos de autenticacion

      gateway.onModuleDestroy()
    })

    it('por defecto el periodo es de 25 s (ADR-020)', async () => {
      const harness = buildChatHarness()
      const { logger } = recordingLogger()
      const gateway = new BattleRoomRealtimeGateway(
        instantVerifier,
        harness.rooms,
        logger,
        harness.handler,
      )
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      // Se autentica: sin ello el plazo de 5 s de ADR-020 la cierra antes del primer ping.
      socket.emit({ type: 'auth', token: 'ok' })
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve()
      }
      jest.advanceTimersByTime(24_999)
      expect(socket.pingCount).toBe(0)

      jest.advanceTimersByTime(1)
      expect(socket.pingCount).toBe(1)

      gateway.onModuleDestroy()
    })
  })

  describe('configuracion del transporte', () => {
    it('declara la ruta de ADR-020 y el maximo de mensaje entrante de 16 KiB', () => {
      const options = Reflect.getMetadata(
        'websockets:gateway_options',
        BattleRoomRealtimeGateway,
      ) as Record<string, unknown> | undefined

      expect(options).toMatchObject({ path: '/api/v1/combat/realtime', maxPayload: 16 * 1024 })
    })
  })
})
