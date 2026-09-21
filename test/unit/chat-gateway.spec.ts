import 'reflect-metadata'

import {
  BattleRoomRealtimeGateway,
  type RealtimeGatewayOptions,
} from '../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import type { BasicAttackRealtimeHandler } from '../../src/adapters/inbound/ws/BasicAttackRealtimeHandler'
import type { ChatRealtimeHandler } from '../../src/adapters/inbound/ws/ChatRealtimeHandler'
import type { RealtimeSocket } from '../../src/adapters/inbound/ws/RealtimeSocket'
import { InMemoryRealtimeTicketStore } from '../../src/adapters/outbound/realtime/InMemoryRealtimeTicketStore'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { RealtimeTicketCodecPort } from '../../src/application/ports/RealtimeTicketPort'
import {
  ConsumeRealtimeTicket,
  IssueRealtimeTicket,
} from '../../src/application/use-cases/RealtimeTickets'
import { ResumeBattle } from '../../src/application/use-cases/ResumeBattle'
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
 * El chat dentro del gateway (HU-13). El gateway y su autenticacion por ticket
 * son de HU-17 (`battle-room-realtime.gateway.spec.ts`); aqui se prueba lo que
 * el chat anade: el enrutado de `chat.*`, el orden de los comandos de una
 * conexion, la baja al desconectar y la reaccion a los cambios de la sala.
 */
const ticketing = (clock: ClockPort) => {
  const store = new InMemoryRealtimeTicketStore()
  let counter = 0
  const codec: RealtimeTicketCodecPort = {
    generate: () => `ticket-${String((counter += 1))}`,
    hash: (ticket) => `h:${ticket}`,
  }

  return {
    consume: new ConsumeRealtimeTicket(codec, store, clock),
    issue: new IssueRealtimeTicket(codec, store, clock),
  }
}

describe('BattleRoomRealtimeGateway con chat (HU-13)', () => {
  const ROOM = uuid(1)
  const lobby = { channel: 'lobby' } as const
  let cmd = 0
  const commandId = (): string => {
    cmd += 1

    return uuid(80_000 + cmd)
  }

  const build = (chat?: ChatRealtimeHandler, options?: RealtimeGatewayOptions) => {
    const harness = buildChatHarness()
    const { logger, logs } = recordingLogger()
    const { consume, issue } = ticketing(harness.clock)
    const gateway = new BattleRoomRealtimeGateway(
      consume,
      harness.rooms,
      new ResumeBattle(harness.rooms),
      logger,
      chat ?? harness.handler,
      { handle: jest.fn() } as unknown as BasicAttackRealtimeHandler,
      options,
    )

    /** Conecta y se autentica con un ticket real del almacen (consumirlo es sincrono). */
    const connect = (subject = 'ana'): FakeSocket => {
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', ticket: issue.execute(subject).ticket })

      return socket
    }

    return { harness, gateway, logs, connect }
  }

  /** Doble del manejador de chat: registra cada comando y lo resuelve como indique `outcome`. */
  const recordingChat = (outcome: (subject: string, count: number) => Promise<void>) => {
    const handled: { client: RealtimeSocket; subject: string; type: unknown }[] = []
    const chat = {
      handle: (client: RealtimeSocket, subject: string, message: Record<string, unknown>) => {
        handled.push({ client, subject, type: message.type })

        return outcome(subject, handled.length)
      },
      onDisconnect: () => undefined,
      onRoomUpdated: () => Promise.resolve(),
    } as unknown as ChatRealtimeHandler

    return { chat, handled }
  }

  describe('orden de los comandos de chat de una conexion', () => {
    it('auth, chat.subscribe y chat.send emitidos en el MISMO instante se atienden EN ORDEN', async () => {
      const { connect } = build()
      const socket = connect()

      socket.emit({ type: 'chat.subscribe', ...lobby })
      socket.emit({ type: 'chat.send', ...lobby, commandId: commandId(), text: 'hola' })
      await flush()

      expect(socket.closeCalls).toEqual([])
      expect(socket.frames().map((f) => f.type)).toEqual([
        'auth.ok',
        'chat.subscribed',
        'chat.message',
        'chat.accepted',
      ])
    })

    it('el comando siguiente espera a que termine el anterior de la MISMA conexion', async () => {
      let release: () => void = () => undefined
      const { chat, handled } = recordingChat((_subject, count) =>
        count === 1
          ? new Promise<void>((resolve) => {
              release = resolve
            })
          : Promise.resolve(),
      )
      const { connect } = build(chat)
      const socket = connect()

      socket.emit({ type: 'chat.subscribe', ...lobby })
      socket.emit({ type: 'chat.send', ...lobby, commandId: commandId(), text: 'hola' })
      await flush()

      expect(handled.map((h) => h.type)).toEqual(['chat.subscribe'])

      release()
      await flush()

      expect(handled.map((h) => h.type)).toEqual(['chat.subscribe', 'chat.send'])
    })

    it('conexiones distintas NO se esperan entre si', async () => {
      const { chat, handled } = recordingChat((subject) =>
        subject === 'ana' ? new Promise<void>(() => undefined) : Promise.resolve(),
      )
      const { connect } = build(chat)
      const stuck = connect('ana')
      const free = connect('beto')

      stuck.emit({ type: 'chat.subscribe', ...lobby })
      stuck.emit({ type: 'chat.send', ...lobby, commandId: commandId(), text: 'espera' })
      free.emit({ type: 'chat.subscribe', ...lobby })
      await flush()

      expect(handled.filter((h) => h.client === free)).toHaveLength(1)
      expect(handled.filter((h) => h.client === stuck)).toHaveLength(1)
    })

    it('un comando que falla se registra y NO detiene los siguientes de la conexion', async () => {
      const { chat, handled } = recordingChat((_subject, count) =>
        count === 1 ? Promise.reject(new Error('base caida')) : Promise.resolve(),
      )
      const { connect, logs } = build(chat)
      const socket = connect()

      socket.emit({ type: 'chat.subscribe', ...lobby })
      socket.emit({ type: 'chat.send', ...lobby, commandId: commandId(), text: 'sigue' })
      await flush()

      expect(handled.map((h) => h.type)).toEqual(['chat.subscribe', 'chat.send'])
      expect(logs.some((l) => l.message === 'realtime_chat_fallo')).toBe(true)
    })
  })

  describe('identidad', () => {
    it('el remitente es el `sub` del ticket: ningun campo del mensaje lo cambia', async () => {
      const { connect, harness } = build()
      const socket = connect('ana')

      socket.emit({ type: 'chat.subscribe', ...lobby })
      socket.emit({
        type: 'chat.send',
        ...lobby,
        commandId: commandId(),
        text: 'soy ana',
        senderId: 'intruso',
        sub: 'intruso',
        subject: 'intruso',
        playerId: 'intruso',
      })
      await flush()

      expect(harness.accountCalls).toEqual(['ana'])
      expect(socket.framesOfType('chat.message')[0]).toMatchObject({
        sender: { displayName: 'nombre-de-ana' },
        text: 'soy ana',
      })
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
      const { connect } = build()
      const socket = connect()

      socket.emit({ type: 'chat.editar', ...lobby })
      await flush()

      expect(socket.closeCalls[0]).toEqual({ code: 4400, reason: 'tipo_no_reconocido' })
    })

    it('un ticket invalido cierra con 4401 y el chat.subscribe que le sigue no se atiende', async () => {
      const { harness, gateway } = build()
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit({ type: 'auth', ticket: 'inventado' })
      socket.emit({ type: 'chat.subscribe', ...lobby })
      await flush()

      expect(socket.closeCalls[0]?.code).toBe(4401)
      expect(harness.handler.subscriberCount('lobby')).toBe(0)
    })
  })

  describe('limite de comandos de chat en espera por conexion', () => {
    it('frontera: 1 en curso + 64 en espera se aceptan y el siguiente cierra con 1008', () => {
      const { chat } = recordingChat(() => new Promise<void>(() => undefined))
      const { connect } = build(chat)
      const socket = connect()

      // El primero empieza a atenderse (no cuenta como «en espera»): y se quedan 64 detras.
      for (let i = 0; i < 65; i += 1) {
        socket.emit({ type: 'chat.subscribe', ...lobby })
      }

      expect(socket.closeCalls).toEqual([])

      socket.emit({ type: 'chat.subscribe', ...lobby })

      expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'demasiados_mensajes' }])
    })
  })

  describe('el chat reacciona a los cambios de la sala', () => {
    it('notifyRoomUpdated expulsa del chat a quien salio de la sala', async () => {
      const { harness, connect, gateway } = build()
      await createRoom(harness.rooms, ROOM, 'creador')
      await joinRoom(harness.rooms, ROOM, 'ana', 'Ana')
      await joinRoom(harness.rooms, ROOM, 'beto', 'Beto')
      const socket = connect('ana')

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
      const failingChat = {
        onRoomUpdated: () => Promise.reject(new Error('base caida')),
        onDisconnect: () => undefined,
        handle: () => Promise.resolve(),
      } as unknown as ChatRealtimeHandler
      const { gateway, logs } = build(failingChat)

      expect(() => {
        gateway.notifyRoomUpdated({ roomId: ROOM, status: 'PREPARING', version: 2 })
      }).not.toThrow()
      await flush()

      expect(logs.some((l) => l.message === 'chat_actualizacion_de_sala_fallo')).toBe(true)
    })

    it('al cerrarse la conexion el chat la da de baja', async () => {
      const { harness, connect } = build()
      const socket = connect()

      socket.emit({ type: 'chat.subscribe', ...lobby })
      await flush()
      expect(harness.handler.subscriberCount('lobby')).toBe(1)

      socket.close()

      expect(harness.handler.subscriberCount('lobby')).toBe(0)
    })

    it('una conexion cortada por el latido de HU-17 tambien se da de baja del chat', async () => {
      // Latido corto: el primer periodo envia el ping y, sin pong, el segundo la termina.
      const { harness, connect } = build(undefined, { heartbeatIntervalMs: 30 })
      const socket = connect()

      socket.emit({ type: 'chat.subscribe', ...lobby })
      await flush()
      expect(harness.handler.subscriberCount('lobby')).toBe(1)

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(socket.terminated).toBe(true)
      expect(harness.handler.subscriberCount('lobby')).toBe(0)
    })
  })
})
