import { DEFAULT_MAX_BUFFERED_BYTES } from '../../src/adapters/inbound/ws/ChatRealtimeHandler'
import { InMemoryChatMessageRepository } from '../../src/adapters/outbound/persistence/InMemoryChatMessageRepository'
import type {
  AppendChatMessageResult,
  ChatHistoryPage,
  ChatHistoryQuery,
  ChatMessageDraft,
  ChatMessageRepositoryPort,
} from '../../src/application/ports/ChatMessageRepositoryPort'
import type { ChatMessage } from '../../src/domain/entities/ChatMessage'
import type { ChatChannel } from '../../src/domain/value-objects/ChatChannel'
import {
  buildChatHarness,
  cancelRoom,
  createRoom,
  joinRoom,
  leaveRoom,
  uuid,
  type ChatHarness,
} from '../fixtures/chat-harness'
import { FakeSocket, flush } from '../fixtures/fake-socket'

/**
 * Manejador del chat sobre sockets falsos (HU-13, RF-13). Cubre cada regla del
 * issue: distribucion al contexto correcto, aislamiento, un solo procesamiento,
 * no perder mensajes aceptados y orden. La conexion real (tramas, tamano
 * maximo, latido) la cubre `test/integration/chat-realtime.spec.ts`.
 */

/** Repositorio con compuerta y fallos inyectables, para probar el orden persistir -> difundir. */
class ControllableChatRepository implements ChatMessageRepositoryPort {
  readonly inner = new InMemoryChatMessageRepository()
  gate: Promise<void> | null = null
  failNextAppend: Error | null = null
  appendCalls = 0

  async append(draft: ChatMessageDraft): Promise<AppendChatMessageResult> {
    this.appendCalls += 1

    if (this.gate !== null) {
      await this.gate
    }

    if (this.failNextAppend !== null) {
      const error = this.failNextAppend

      this.failNextAppend = null
      throw error
    }

    return this.inner.append(draft)
  }

  findByCommand(senderId: string, commandId: string): Promise<ChatMessage | null> {
    return this.inner.findByCommand(senderId, commandId)
  }

  /** Si se fija, la lectura devuelve el historial YA leido pero solo cuando la compuerta se abre. */
  readGate: Promise<void> | null = null

  async readHistory(channel: ChatChannel, query: ChatHistoryQuery): Promise<ChatHistoryPage> {
    const page = await this.inner.readHistory(channel, query)

    if (this.readGate !== null) {
      await this.readGate
    }

    return page
  }
}

describe('ChatRealtimeHandler', () => {
  const ROOM_A = uuid(1)
  const ROOM_B = uuid(2)
  let cmd = 0
  const commandId = (): string => {
    cmd += 1

    return uuid(70_000 + cmd)
  }

  const lobby = { channel: 'lobby' } as const
  const room = (roomId: string) => ({ channel: 'room', roomId }) as const

  const subscribe = (
    h: ChatHarness,
    socket: FakeSocket,
    subject: string,
    channel: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<void> =>
    h.handler.handle(socket, subject, { type: 'chat.subscribe', ...channel, ...extra })

  const say = (
    h: ChatHarness,
    socket: FakeSocket,
    subject: string,
    channel: Record<string, unknown>,
    text: string,
    id: string = commandId(),
  ): Promise<void> =>
    h.handler.handle(socket, subject, { type: 'chat.send', ...channel, commandId: id, text })

  const seqsOf = (socket: FakeSocket): number[] =>
    socket.framesOfType('chat.message').map((frame) => frame.seq as number)

  const textsOf = (socket: FakeSocket): string[] =>
    socket.framesOfType('chat.message').map((frame) => frame.text as string)

  /** Sala con Ana y Beto (con nombre en la sala) y Carla (sin snapshot). */
  const seedRoom = async (h: ChatHarness, roomId = ROOM_A): Promise<void> => {
    await createRoom(h.rooms, roomId, 'creador')
    await joinRoom(h.rooms, roomId, 'ana', 'Ana')
    await joinRoom(h.rooms, roomId, 'beto', 'Beto')
  }

  /** Conecta y suscribe un jugador al canal dado; devuelve su socket con las tramas ya limpias. */
  const joinChannel = async (
    h: ChatHarness,
    subject: string,
    channel: Record<string, unknown>,
  ): Promise<FakeSocket> => {
    const socket = new FakeSocket()

    await subscribe(h, socket, subject, channel)
    socket.clear()

    return socket
  }

  describe('suscripcion', () => {
    it('lobby: responde chat.subscribed con historial vacio y registra la conexion', async () => {
      const h = buildChatHarness()
      const socket = new FakeSocket()

      await subscribe(h, socket, 'ana', lobby)

      expect(socket.last()).toEqual({
        type: 'chat.subscribed',
        channel: 'lobby',
        upTo: 0,
        truncated: false,
        messages: [],
      })
      expect(h.handler.subscriberCount('lobby')).toBe(1)
    })

    it('sala: un participante se suscribe y la respuesta lleva el roomId', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const socket = new FakeSocket()

      await subscribe(h, socket, 'ana', room(ROOM_A))

      expect(socket.last()).toMatchObject({
        type: 'chat.subscribed',
        channel: 'room',
        roomId: ROOM_A,
      })
      expect(h.handler.subscriberCount(`room:${ROOM_A}`)).toBe(1)
    })

    it.each([
      ['un jugador que no es participante', 'intruso', 'NOT_A_PARTICIPANT', ROOM_A],
      ['una sala inexistente', 'ana', 'ROOM_NOT_FOUND', uuid(404)],
    ])('se rechaza: %s', async (_label, subject, code, roomId) => {
      const h = buildChatHarness()
      await seedRoom(h)
      const socket = new FakeSocket()

      await subscribe(h, socket, subject, room(roomId))

      expect(socket.last()).toEqual({ type: 'command.rejected', command: 'chat.subscribe', code })
      expect(h.handler.subscriberCount(`room:${roomId}`)).toBe(0)
    })

    it('una sala cancelada no admite suscripciones', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      await cancelRoom(h.rooms, ROOM_A, 'creador')
      const socket = new FakeSocket()

      await subscribe(h, socket, 'ana', room(ROOM_A))

      expect(socket.last()).toMatchObject({ code: 'ROOM_NOT_ACTIVE' })
      expect(h.handler.subscriberCount(`room:${ROOM_A}`)).toBe(0)
    })

    it.each([
      ['sin canal', {}],
      ['canal desconocido', { channel: 'global' }],
      ['sala sin roomId', { channel: 'room' }],
      ['sala con roomId invalido', { channel: 'room', roomId: 'x' }],
      ['lobby con roomId', { channel: 'lobby', roomId: ROOM_A }],
    ])('un canal mal formado (%s) es INVALID_COMMAND', async (_label, channel) => {
      const h = buildChatHarness()
      const socket = new FakeSocket()

      await subscribe(h, socket, 'ana', channel)

      expect(socket.last()).toMatchObject({ type: 'command.rejected', code: 'INVALID_COMMAND' })
    })

    it.each([-1, 1.5, '3', null, Number.NaN, Number.MAX_VALUE])(
      'un lastSeq invalido (%p) es INVALID_COMMAND y no suscribe',
      async (lastSeq) => {
        const h = buildChatHarness()
        const socket = new FakeSocket()

        await subscribe(h, socket, 'ana', lobby, { lastSeq })

        expect(socket.last()).toMatchObject({ code: 'INVALID_COMMAND' })
        expect(h.handler.subscriberCount('lobby')).toBe(0)
      },
    )

    it('suscribirse dos veces deja UNA suscripcion: cada mensaje llega una sola vez', async () => {
      const h = buildChatHarness()
      const ana = new FakeSocket()
      await subscribe(h, ana, 'ana', lobby)
      await subscribe(h, ana, 'ana', lobby)
      ana.clear()

      await say(h, ana, 'ana', lobby, 'hola')

      expect(h.handler.subscriberCount('lobby')).toBe(1)
      expect(ana.framesOfType('chat.message')).toHaveLength(1)
    })
  })

  describe('historial al suscribirse (no perder mensajes aceptados)', () => {
    const withHistory = async (h: ChatHarness, count: number): Promise<void> => {
      const writer = await joinChannel(h, 'ana', lobby)

      for (let i = 1; i <= count; i += 1) {
        await say(h, writer, 'ana', lobby, `mensaje ${String(i)}`)
        h.clock.advance(3_000)
      }
    }

    it('quien llega despues recibe el historial retenido, en orden', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100 })
      await withHistory(h, 3)
      const late = new FakeSocket()

      await subscribe(h, late, 'beto', lobby)

      const frame = late.last() as { messages: { seq: number; text: string }[]; upTo: number }

      expect(frame.messages.map((m) => m.seq)).toEqual([1, 2, 3])
      expect(frame.messages.map((m) => m.text)).toEqual(['mensaje 1', 'mensaje 2', 'mensaje 3'])
      expect(frame.upTo).toBe(3)
    })

    it('con lastSeq solo recibe lo que le falta: lastSeq = 2 -> el 3', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100 })
      await withHistory(h, 3)
      const reconnecting = new FakeSocket()

      await subscribe(h, reconnecting, 'beto', lobby, { lastSeq: 2 })

      const frame = reconnecting.last() as { messages: { seq: number }[]; upTo: number }

      expect(frame.messages.map((m) => m.seq)).toEqual([3])
      expect(frame.upTo).toBe(3)
    })

    it('al dia (lastSeq = ultimo seq): sin mensajes y upTo intacto', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100 })
      await withHistory(h, 3)
      const upToDate = new FakeSocket()

      await subscribe(h, upToDate, 'beto', lobby, { lastSeq: 3 })

      expect(upToDate.last()).toMatchObject({ messages: [], upTo: 3, truncated: false })
    })

    it('el historial es acotado: solo los mas recientes y `truncated` lo declara', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100, historyLimit: 2 })
      await withHistory(h, 5)
      const late = new FakeSocket()

      await subscribe(h, late, 'beto', lobby)

      const frame = late.last() as { messages: { seq: number }[]; truncated: boolean }

      expect(frame.messages.map((m) => m.seq)).toEqual([4, 5])
      expect(frame.truncated).toBe(true)
    })

    it('el historial no incluye mensajes expirados', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100, retentionMs: 5_000 })
      const start = h.clock.now().getTime()
      await withHistory(h, 3) // mensajes en t = 0, 3 y 6 s: caducan en t = 5, 8 y 11 s
      h.clock.set(new Date(start + 7_000)) // el 1 ya caduco; el 2 y el 3 siguen vigentes
      const late = new FakeSocket()

      await subscribe(h, late, 'beto', lobby)

      const frame = late.last() as { messages: { seq: number }[]; upTo: number }

      expect(frame.messages.map((m) => m.seq)).toEqual([2, 3])
      expect(frame.upTo).toBe(3)
    })

    it('el historial de una sala no incluye el del lobby', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100 })
      await seedRoom(h)
      const writer = await joinChannel(h, 'ana', lobby)
      await say(h, writer, 'ana', lobby, 'solo lobby')
      const inRoom = new FakeSocket()

      await subscribe(h, inRoom, 'ana', room(ROOM_A))

      expect(inRoom.last()).toMatchObject({ messages: [], upTo: 0 })
    })
  })

  describe('CA-01: distribucion en tiempo real al contexto', () => {
    it('un mensaje del lobby llega a TODOS los suscritos al lobby, remitente incluido', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      const carla = await joinChannel(h, 'carla', lobby)

      await say(h, ana, 'ana', lobby, 'quien juega?')

      for (const socket of [ana, beto, carla]) {
        expect(textsOf(socket)).toEqual(['quien juega?'])
      }
    })

    it('un mensaje de sala llega a los participantes suscritos a esa sala', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = await joinChannel(h, 'ana', room(ROOM_A))
      const beto = await joinChannel(h, 'beto', room(ROOM_A))

      await say(h, ana, 'ana', room(ROOM_A), 'listos?')

      expect(textsOf(ana)).toEqual(['listos?'])
      expect(textsOf(beto)).toEqual(['listos?'])
    })

    it('el remitente recibe ademas chat.accepted; los demas NO', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      const id = commandId()

      await say(h, ana, 'ana', lobby, 'hola', id)

      expect(ana.framesOfType('chat.accepted')).toEqual([
        {
          type: 'chat.accepted',
          commandId: id,
          seq: 1,
          messageId: expect.any(String),
          duplicate: false,
        },
      ])
      expect(beto.framesOfType('chat.accepted')).toHaveLength(0)
    })

    it('el remitente recibe primero el mensaje y luego el aceptado', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)

      await say(h, ana, 'ana', lobby, 'hola')

      expect(ana.frames().map((f) => f.type)).toEqual(['chat.message', 'chat.accepted'])
    })

    it('el mensaje del lobby lleva exactamente los campos del contrato', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const id = commandId()

      await say(h, ana, 'ana', lobby, 'hola', id)

      expect(ana.framesOfType('chat.message')[0]).toEqual({
        type: 'chat.message',
        messageId: expect.any(String),
        channel: 'lobby',
        seq: 1,
        commandId: id,
        sender: { displayName: 'nombre-de-ana' },
        text: 'hola',
        sentAt: h.clock.now().toISOString(),
      })
    })

    it('el mensaje de sala lleva ademas el roomId y el nombre con el que el jugador se unio', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = await joinChannel(h, 'ana', room(ROOM_A))

      await say(h, ana, 'ana', room(ROOM_A), 'hola sala')

      expect(ana.framesOfType('chat.message')[0]).toMatchObject({
        channel: 'room',
        roomId: ROOM_A,
        sender: { displayName: 'Ana' },
      })
    })

    it('el identificador de cuenta del remitente (sub) NUNCA viaja a los clientes', async () => {
      const h = buildChatHarness({
        accountProfiles: {
          getBattleProfile: (subject) =>
            Promise.resolve({ subject, displayName: 'Ana Perez', avatarUrl: null }),
        },
      })
      const ana = await joinChannel(h, 'sub-9f8e7d6c-secreto', lobby)
      const beto = await joinChannel(h, 'sub-otro-usuario', lobby)

      await say(h, ana, 'sub-9f8e7d6c-secreto', lobby, 'hola')
      const late = new FakeSocket()
      await subscribe(h, late, 'sub-otro-usuario', lobby)

      for (const socket of [ana, beto, late]) {
        expect(JSON.stringify(socket.frames())).not.toContain('sub-9f8e7d6c-secreto')
      }
    })

    it('la hora del mensaje es la del servidor', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      h.clock.set(new Date('2026-01-02T03:04:05.678Z'))

      await say(h, ana, 'ana', lobby, 'hola')

      expect(ana.framesOfType('chat.message')[0]).toMatchObject({
        sentAt: '2026-01-02T03:04:05.678Z',
      })
    })
  })

  describe('aislamiento entre contextos (RF-13)', () => {
    it('un mensaje de la sala A NO llega a la sala B, ni al lobby, ni a conexiones sin suscripcion', async () => {
      const h = buildChatHarness()
      await seedRoom(h, ROOM_A)
      await createRoom(h.rooms, ROOM_B, 'creador')
      await joinRoom(h.rooms, ROOM_B, 'carla', 'Carla')
      const inA = await joinChannel(h, 'ana', room(ROOM_A))
      const inB = await joinChannel(h, 'carla', room(ROOM_B))
      const inLobby = await joinChannel(h, 'dora', lobby)
      const connectedOnly = new FakeSocket()

      await say(h, inA, 'ana', room(ROOM_A), 'secreto de la sala A')

      expect(textsOf(inA)).toEqual(['secreto de la sala A'])
      expect(inB.sent).toEqual([])
      expect(inLobby.sent).toEqual([])
      expect(connectedOnly.sent).toEqual([])
    })

    it('un mensaje del lobby NO llega a las salas', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const inRoom = await joinChannel(h, 'ana', room(ROOM_A))
      const inLobby = await joinChannel(h, 'dora', lobby)

      await say(h, inLobby, 'dora', lobby, 'para el lobby')

      expect(textsOf(inLobby)).toEqual(['para el lobby'])
      expect(inRoom.sent).toEqual([])
    })

    it('una conexion suscrita a dos contextos recibe cada mensaje una vez y con su canal', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = new FakeSocket()
      await subscribe(h, ana, 'ana', lobby)
      await subscribe(h, ana, 'ana', room(ROOM_A))
      const beto = await joinChannel(h, 'beto', room(ROOM_A))
      const dora = await joinChannel(h, 'dora', lobby)
      ana.clear()

      await say(h, beto, 'beto', room(ROOM_A), 'de la sala')
      await say(h, dora, 'dora', lobby, 'del lobby')

      const frames = ana.framesOfType('chat.message')

      expect(frames.map((f) => [f.channel, f.text])).toEqual([
        ['room', 'de la sala'],
        ['lobby', 'del lobby'],
      ])
    })

    it('no se puede escribir en un contexto al que no se esta suscrito (NOT_SUBSCRIBED)', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const inLobby = await joinChannel(h, 'ana', lobby)
      const observer = await joinChannel(h, 'beto', room(ROOM_A))
      const id = commandId()

      await say(h, inLobby, 'ana', room(ROOM_A), 'colado', id)

      expect(inLobby.last()).toEqual({
        type: 'command.rejected',
        command: 'chat.send',
        commandId: id,
        code: 'NOT_SUBSCRIBED',
      })
      expect(observer.sent).toEqual([])
    })

    it('estar suscrito a la sala A no permite escribir en la sala B', async () => {
      const h = buildChatHarness()
      await seedRoom(h, ROOM_A)
      await seedRoom(h, ROOM_B)
      const inA = await joinChannel(h, 'ana', room(ROOM_A))
      const inB = await joinChannel(h, 'beto', room(ROOM_B))

      await say(h, inA, 'ana', room(ROOM_B), 'colado')

      expect(inA.last()).toMatchObject({ code: 'NOT_SUBSCRIBED' })
      expect(inB.sent).toEqual([])
    })

    it('una conexion sin ninguna suscripcion no puede escribir', async () => {
      const h = buildChatHarness()
      const socket = new FakeSocket()

      await say(h, socket, 'ana', lobby, 'hola')

      expect(socket.last()).toMatchObject({ code: 'NOT_SUBSCRIBED' })
    })

    it('si el jugador salio de la sala y la suscripcion sigue viva, el envio se rechaza igual', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = await joinChannel(h, 'ana', room(ROOM_A))
      const beto = await joinChannel(h, 'beto', room(ROOM_A))

      // Sale sin que nadie avise al manejador (p. ej. la notificacion se perdio).
      await leaveRoom(h.rooms, ROOM_A, 'ana')
      await say(h, ana, 'ana', room(ROOM_A), 'sigo aqui?')

      expect(ana.last()).toMatchObject({ code: 'NOT_A_PARTICIPANT' })
      expect(beto.sent).toEqual([])
    })
  })

  describe('rechazos: solo a quien envia', () => {
    it.each([
      ['mensaje vacio', '   ', 'EMPTY_MESSAGE'],
      ['caracter de control', 'a\u0000b', 'INVALID_CHARACTERS'],
    ])('%s -> %s', async (_label, text, code) => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      const id = commandId()

      await say(h, ana, 'ana', lobby, text, id)

      expect(ana.last()).toEqual({
        type: 'command.rejected',
        command: 'chat.send',
        commandId: id,
        code,
      })
      expect(beto.sent).toEqual([])
      expect((await h.readHistory.execute({ kind: 'LOBBY' }, null)).messages).toEqual([])
    })

    it('un mensaje demasiado largo declara el maximo', async () => {
      const h = buildChatHarness({ maxMessageLength: 5 })
      const ana = await joinChannel(h, 'ana', lobby)

      await say(h, ana, 'ana', lobby, 'abcdef')

      expect(ana.last()).toMatchObject({ code: 'MESSAGE_TOO_LONG', maxLength: 5 })
    })

    it('frontera: el maximo exacto se acepta', async () => {
      const h = buildChatHarness({ maxMessageLength: 5 })
      const ana = await joinChannel(h, 'ana', lobby)

      await say(h, ana, 'ana', lobby, 'abcde')

      expect(textsOf(ana)).toEqual(['abcde'])
    })

    it('exceso de frecuencia: RATE_LIMITED con el tiempo de espera; nada se difunde', async () => {
      const h = buildChatHarness({ rateLimitMessages: 2 })
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)

      await say(h, ana, 'ana', lobby, 'uno')
      await say(h, ana, 'ana', lobby, 'dos')
      beto.clear()
      ana.clear()
      await say(h, ana, 'ana', lobby, 'tres')

      expect(ana.last()).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 10_000 })
      expect(beto.sent).toEqual([])
    })

    it.each([
      ['sin commandId', undefined],
      ['commandId numerico', 5],
      ['commandId que no es UUID', 'abc'],
    ])('%s -> INVALID_COMMAND', async (_label, badId) => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)

      await h.handler.handle(ana, 'ana', {
        type: 'chat.send',
        ...lobby,
        commandId: badId,
        text: 'hola',
      })

      expect(ana.last()).toMatchObject({ code: 'INVALID_COMMAND' })
    })

    it('un texto que no es cadena -> INVALID_COMMAND', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)

      await h.handler.handle(ana, 'ana', {
        type: 'chat.send',
        ...lobby,
        commandId: commandId(),
        text: { html: '<b>x</b>' },
      })

      expect(ana.last()).toMatchObject({ code: 'INVALID_COMMAND' })
    })

    it('el rechazo no incluye commandId cuando el cliente no envio uno', async () => {
      const h = buildChatHarness()
      const socket = new FakeSocket()

      await h.handler.handle(socket, 'ana', { type: 'chat.send', ...lobby, text: 'hola' })

      expect(socket.last()).toEqual({
        type: 'command.rejected',
        command: 'chat.send',
        code: 'NOT_SUBSCRIBED',
      })
    })

    it('reutilizar un commandId en otro canal -> COMMAND_ID_REUSED', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = new FakeSocket()
      await subscribe(h, ana, 'ana', lobby)
      await subscribe(h, ana, 'ana', room(ROOM_A))
      const id = commandId()

      await say(h, ana, 'ana', lobby, 'en el lobby', id)
      ana.clear()
      await say(h, ana, 'ana', room(ROOM_A), 'en la sala', id)

      expect(ana.last()).toMatchObject({ code: 'COMMAND_ID_REUSED', commandId: id })
    })

    it('un sujeto sin cuenta en Account -> ACCOUNT_PROFILE_NOT_FOUND', async () => {
      const { AccountProfileMissingError } =
        await import('../../src/application/errors/UpstreamErrors')
      const h = buildChatHarness({
        accountProfiles: {
          getBattleProfile: (subject) => Promise.reject(new AccountProfileMissingError(subject)),
        },
      })
      const ana = await joinChannel(h, 'ana', lobby)

      await say(h, ana, 'ana', lobby, 'hola')

      expect(ana.last()).toMatchObject({ code: 'ACCOUNT_PROFILE_NOT_FOUND' })
    })
  })

  describe('procesado una sola vez (RF-13, ADR-020)', () => {
    it('repetir el commandId responde chat.accepted duplicado con el MISMO seq y NO difunde otra vez', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      const id = commandId()

      await say(h, ana, 'ana', lobby, 'hola', id)
      const acceptedFirst = ana.framesOfType('chat.accepted')[0]
      ana.clear()
      beto.clear()

      await say(h, ana, 'ana', lobby, 'hola', id)

      expect(ana.frames()).toEqual([
        {
          type: 'chat.accepted',
          commandId: id,
          seq: acceptedFirst?.seq,
          messageId: acceptedFirst?.messageId,
          duplicate: true,
        },
      ])
      expect(beto.sent).toEqual([])
      expect((await h.readHistory.execute({ kind: 'LOBBY' }, null)).messages).toHaveLength(1)
    })

    it('el mismo comando dos veces A LA VEZ: un solo mensaje y una sola difusion', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      const id = commandId()

      await Promise.all([
        say(h, ana, 'ana', lobby, 'doble clic', id),
        say(h, ana, 'ana', lobby, 'doble clic', id),
      ])

      expect(beto.framesOfType('chat.message')).toHaveLength(1)
      const accepts = ana.framesOfType('chat.accepted')

      expect(accepts).toHaveLength(2)
      expect(new Set(accepts.map((a) => a.seq)).size).toBe(1)
      expect(accepts.filter((a) => a.duplicate === false)).toHaveLength(1)
    })

    it('el mismo commandId de dos jugadores distintos son dos mensajes', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      const id = commandId()

      await say(h, ana, 'ana', lobby, 'de ana', id)
      await say(h, beto, 'beto', lobby, 'de beto', id)

      expect(textsOf(ana)).toEqual(['de ana', 'de beto'])
    })
  })

  describe('orden e integridad', () => {
    it('mensajes concurrentes de varios remitentes llegan a todos en orden de seq, sin huecos ni repetidos', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100 })
      const senders = ['ana', 'beto', 'carla', 'dora']
      const sockets = await Promise.all(senders.map((s) => joinChannel(h, s, lobby)))

      const sends: Promise<void>[] = []
      for (let i = 0; i < 20; i += 1) {
        const index = i % senders.length
        const socket = sockets.at(index)
        const subject = senders.at(index)

        if (socket === undefined || subject === undefined) {
          throw new Error('indice fuera de rango')
        }

        sends.push(say(h, socket, subject, lobby, `m${String(i)}`))
      }
      await Promise.all(sends)

      const expected = [...Array(20).keys()].map((i) => i + 1)

      for (const socket of sockets) {
        expect(seqsOf(socket)).toEqual(expected)
      }
    })

    it('todos los suscritos ven la misma secuencia de textos', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100 })
      const a = await joinChannel(h, 'ana', lobby)
      const b = await joinChannel(h, 'beto', lobby)

      await Promise.all([
        say(h, a, 'ana', lobby, 'a1'),
        say(h, b, 'beto', lobby, 'b1'),
        say(h, a, 'ana', lobby, 'a2'),
        say(h, b, 'beto', lobby, 'b2'),
      ])

      expect(textsOf(a)).toEqual(textsOf(b))
      expect(textsOf(a)).toHaveLength(4)
    })

    it('cada sala cuenta su propio seq desde 1', async () => {
      const h = buildChatHarness()
      await seedRoom(h, ROOM_A)
      await seedRoom(h, ROOM_B)
      const a = await joinChannel(h, 'ana', room(ROOM_A))
      const b = await joinChannel(h, 'ana', room(ROOM_B))

      await say(h, a, 'ana', room(ROOM_A), 'en A')
      await say(h, b, 'ana', room(ROOM_B), 'en B')

      expect(seqsOf(a)).toEqual([1])
      expect(seqsOf(b)).toEqual([1])
    })
  })

  describe('persistir ANTES de difundir (ADR-020)', () => {
    it('no se difunde nada mientras el almacen no haya aceptado el mensaje', async () => {
      const repo = new ControllableChatRepository()
      const h = buildChatHarness({ messages: repo })
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      let release: () => void = () => undefined
      repo.gate = new Promise<void>((resolve) => {
        release = resolve
      })

      const sending = say(h, ana, 'ana', lobby, 'en vuelo')
      await flush()

      expect(repo.appendCalls).toBe(1)
      expect(beto.sent).toEqual([])
      expect(ana.sent).toEqual([])

      release()
      await sending

      expect(textsOf(beto)).toEqual(['en vuelo'])
    })

    it('si la persistencia falla NO se difunde nada y el remitente recibe CHAT_UNAVAILABLE', async () => {
      const repo = new ControllableChatRepository()
      const h = buildChatHarness({ messages: repo })
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      repo.failNextAppend = new Error('MongoServerError: conexion perdida')
      const id = commandId()

      await say(h, ana, 'ana', lobby, 'texto privado del jugador', id)

      expect(ana.last()).toEqual({
        type: 'command.rejected',
        command: 'chat.send',
        commandId: id,
        code: 'CHAT_UNAVAILABLE',
      })
      expect(beto.sent).toEqual([])
    })

    it('el fallo se registra SIN el contenido del mensaje', async () => {
      const repo = new ControllableChatRepository()
      const h = buildChatHarness({ messages: repo })
      const ana = await joinChannel(h, 'ana', lobby)
      repo.failNextAppend = new Error('conexion perdida')

      await say(h, ana, 'ana', lobby, 'texto privado del jugador')

      const errors = h.logs.filter((log) => log.level === 'error')

      expect(errors).toHaveLength(1)
      expect(JSON.stringify(errors)).not.toContain('texto privado del jugador')
    })

    it('tras un fallo el canal sigue funcionando y el reintento del mismo comando se acepta', async () => {
      const repo = new ControllableChatRepository()
      const h = buildChatHarness({ messages: repo })
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      const id = commandId()
      repo.failNextAppend = new Error('caida momentanea')

      await say(h, ana, 'ana', lobby, 'reintento', id)
      ana.clear()
      await say(h, ana, 'ana', lobby, 'reintento', id)

      expect(textsOf(beto)).toEqual(['reintento'])
      expect(ana.framesOfType('chat.accepted')[0]).toMatchObject({ seq: 1, duplicate: false })
    })

    it('un mensaje aceptado MIENTRAS una suscripcion lee su historial no se pierde', async () => {
      const repo = new ControllableChatRepository()
      const h = buildChatHarness({ messages: repo })
      const ana = await joinChannel(h, 'ana', lobby)
      let release: () => void = () => undefined
      repo.readGate = new Promise<void>((resolve) => {
        release = resolve
      })

      // Beto lee un historial (vacio) y queda detenido justo antes de registrarse...
      const late = new FakeSocket()
      const subscribing = subscribe(h, late, 'beto', lobby)
      await flush()

      // ...y en ese hueco Ana envia un mensaje que se acepta.
      const sending = say(h, ana, 'ana', lobby, 'durante la lectura')
      await flush()
      release()
      await Promise.all([subscribing, sending])

      const subscribed = late.framesOfType('chat.subscribed')[0] as { messages: { text: string }[] }
      const inHistory = subscribed.messages.filter((m) => m.text === 'durante la lectura').length
      const live = textsOf(late).filter((t) => t === 'durante la lectura').length

      expect(inHistory + live).toBe(1)
    })

    it('una suscripcion que coincide con un envio en vuelo ve el mensaje UNA vez (ni pierde ni duplica)', async () => {
      const repo = new ControllableChatRepository()
      const h = buildChatHarness({ messages: repo })
      const ana = await joinChannel(h, 'ana', lobby)
      let release: () => void = () => undefined
      repo.gate = new Promise<void>((resolve) => {
        release = resolve
      })

      const sending = say(h, ana, 'ana', lobby, 'justo ahora')
      await flush()
      const late = new FakeSocket()
      const subscribing = subscribe(h, late, 'beto', lobby)
      await flush()

      release()
      await Promise.all([sending, subscribing])

      const inHistory = (
        late.framesOfType('chat.subscribed')[0]?.messages as { text: string }[]
      ).filter((m) => m.text === 'justo ahora').length
      const live = textsOf(late).filter((t) => t === 'justo ahora').length

      expect(inHistory + live).toBe(1)
    })
  })

  describe('expulsion cuando cambia la sala (onRoomUpdated)', () => {
    it('quien abandona la sala deja de recibir su chat y se le avisa; los demas siguen', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = await joinChannel(h, 'ana', room(ROOM_A))
      const beto = await joinChannel(h, 'beto', room(ROOM_A))

      await leaveRoom(h.rooms, ROOM_A, 'ana')
      await h.handler.onRoomUpdated(ROOM_A)

      expect(ana.last()).toEqual({
        type: 'chat.unsubscribed',
        channel: 'room',
        roomId: ROOM_A,
        reason: 'NOT_A_PARTICIPANT',
      })
      expect(h.handler.subscriberCount(`room:${ROOM_A}`)).toBe(1)

      ana.clear()
      await say(h, beto, 'beto', room(ROOM_A), 'ya se fue ana')

      expect(ana.sent).toEqual([])
      expect(textsOf(beto)).toEqual(['ya se fue ana'])
    })

    it('si el jugador sale de la sala MIENTRAS su suscripcion espera el cerrojo, no se registra', async () => {
      const repo = new ControllableChatRepository()
      const h = buildChatHarness({ messages: repo })
      await seedRoom(h)
      await joinChannel(h, 'beto', room(ROOM_A))
      const writer = await joinChannel(h, 'beto', room(ROOM_A))
      let release: () => void = () => undefined
      repo.gate = new Promise<void>((resolve) => {
        release = resolve
      })

      // Un envio en vuelo retiene el cerrojo del canal de la sala.
      const sending = say(h, writer, 'beto', room(ROOM_A), 'reteniendo el cerrojo')
      await flush()

      // Ana pasa la primera comprobacion y queda esperando el cerrojo...
      const ana = new FakeSocket()
      const subscribing = subscribe(h, ana, 'ana', room(ROOM_A))
      await flush()

      // ...y sale de la sala antes de que le toque.
      await leaveRoom(h.rooms, ROOM_A, 'ana')
      release()
      await Promise.all([sending, subscribing])

      expect(ana.last()).toMatchObject({ type: 'command.rejected', code: 'NOT_A_PARTICIPANT' })
      expect(ana.framesOfType('chat.subscribed')).toHaveLength(0)
      // Solo quedan las dos conexiones de Beto: Ana no se registro.
      expect(h.handler.subscriberCount(`room:${ROOM_A}`)).toBe(2)
    })

    it('una sala cancelada expulsa a todos sus suscriptores', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = await joinChannel(h, 'ana', room(ROOM_A))
      const beto = await joinChannel(h, 'beto', room(ROOM_A))

      await cancelRoom(h.rooms, ROOM_A, 'creador')
      await h.handler.onRoomUpdated(ROOM_A)

      for (const socket of [ana, beto]) {
        expect(socket.last()).toMatchObject({
          type: 'chat.unsubscribed',
          reason: 'ROOM_NOT_ACTIVE',
        })
      }
      expect(h.handler.subscriberCount(`room:${ROOM_A}`)).toBe(0)
    })

    it('el expulsado ya no puede escribir en esa sala (NOT_SUBSCRIBED)', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = await joinChannel(h, 'ana', room(ROOM_A))
      await leaveRoom(h.rooms, ROOM_A, 'ana')
      await h.handler.onRoomUpdated(ROOM_A)
      ana.clear()

      await say(h, ana, 'ana', room(ROOM_A), 'hola?')

      expect(ana.last()).toMatchObject({ code: 'NOT_SUBSCRIBED' })
    })

    it('una actualizacion que no cambia el acceso no expulsa a nadie', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = await joinChannel(h, 'ana', room(ROOM_A))

      await joinRoom(h.rooms, ROOM_A, 'carla', 'Carla')
      await h.handler.onRoomUpdated(ROOM_A)

      expect(ana.sent).toEqual([])
      expect(h.handler.subscriberCount(`room:${ROOM_A}`)).toBe(1)
    })

    it('la expulsion de una sala no toca la suscripcion al lobby de la misma conexion', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = new FakeSocket()
      await subscribe(h, ana, 'ana', lobby)
      await subscribe(h, ana, 'ana', room(ROOM_A))
      const dora = await joinChannel(h, 'dora', lobby)

      await leaveRoom(h.rooms, ROOM_A, 'ana')
      await h.handler.onRoomUpdated(ROOM_A)
      ana.clear()
      await say(h, dora, 'dora', lobby, 'sigues en el lobby')

      expect(textsOf(ana)).toEqual(['sigues en el lobby'])
    })

    it('otra sala no se ve afectada por los cambios de la primera', async () => {
      const h = buildChatHarness()
      await seedRoom(h, ROOM_A)
      await seedRoom(h, ROOM_B)
      const inB = await joinChannel(h, 'ana', room(ROOM_B))

      await cancelRoom(h.rooms, ROOM_A, 'creador')
      await h.handler.onRoomUpdated(ROOM_A)

      expect(inB.sent).toEqual([])
      expect(h.handler.subscriberCount(`room:${ROOM_B}`)).toBe(1)
    })

    it('una sala sin suscriptores no consulta nada', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const findById = jest.spyOn(h.rooms, 'findById')

      await h.handler.onRoomUpdated(ROOM_A)

      expect(findById).not.toHaveBeenCalled()
    })

    it('un roomId que no es UUID se ignora sin lanzar', async () => {
      const h = buildChatHarness()

      await expect(h.handler.onRoomUpdated('no-es-uuid')).resolves.toBeUndefined()
    })

    it('si no se puede revalidar (fallo de infraestructura) NO se expulsa a nadie y se registra', async () => {
      const h = buildChatHarness()
      await seedRoom(h)
      const ana = await joinChannel(h, 'ana', room(ROOM_A))
      jest.spyOn(h.rooms, 'findById').mockRejectedValueOnce(new Error('base caida'))

      await h.handler.onRoomUpdated(ROOM_A)

      expect(ana.sent).toEqual([])
      expect(h.handler.subscriberCount(`room:${ROOM_A}`)).toBe(1)
      expect(h.logs.some((log) => log.message === 'chat_revalidacion_fallo')).toBe(true)
    })
  })

  describe('cancelar suscripcion y desconexion', () => {
    it('chat.unsubscribe: confirma, deja de recibir y ya no puede escribir', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)

      await h.handler.handle(ana, 'ana', { type: 'chat.unsubscribe', ...lobby })

      expect(ana.last()).toEqual({
        type: 'chat.unsubscribed',
        channel: 'lobby',
        reason: 'REQUESTED',
      })

      ana.clear()
      await say(h, beto, 'beto', lobby, 'hola')
      expect(ana.sent).toEqual([])

      await say(h, ana, 'ana', lobby, 'mudo')
      expect(ana.last()).toMatchObject({ code: 'NOT_SUBSCRIBED' })
    })

    it('chat.unsubscribe con un canal mal formado es INVALID_COMMAND', async () => {
      const h = buildChatHarness()
      const ana = new FakeSocket()

      await h.handler.handle(ana, 'ana', { type: 'chat.unsubscribe', channel: 'nada' })

      expect(ana.last()).toMatchObject({ command: 'chat.unsubscribe', code: 'INVALID_COMMAND' })
    })

    it('al desconectarse la conexion deja de figurar como suscriptora', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      await joinChannel(h, 'beto', lobby)

      h.handler.onDisconnect(ana)

      expect(h.handler.subscriberCount('lobby')).toBe(1)
    })

    it('desconectar libera el canal vacio', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)

      h.handler.onDisconnect(ana)

      expect(h.handler.subscriberCount('lobby')).toBe(0)
    })

    it('desconectar una conexion desconocida no hace nada', () => {
      const h = buildChatHarness()

      expect(() => {
        h.handler.onDisconnect(new FakeSocket())
      }).not.toThrow()
    })

    it('un socket ya cerrado pero aun registrado no recibe nada y no rompe la difusion', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      beto.readyState = 3

      await say(h, ana, 'ana', lobby, 'hola')

      expect(beto.sent).toEqual([])
      expect(textsOf(ana)).toEqual(['hola'])
    })

    it('reconexion: quien vuelve con su lastSeq recupera EXACTAMENTE lo que le falto', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100 })
      const writer = await joinChannel(h, 'ana', lobby)
      const first = await joinChannel(h, 'beto', lobby)

      await say(h, writer, 'ana', lobby, 'uno')
      await say(h, writer, 'ana', lobby, 'dos')
      const lastSeenByBeto = seqsOf(first).at(-1)

      if (lastSeenByBeto === undefined) {
        throw new Error('beto no llego a ver ningun mensaje')
      }

      // Beto se cae; mientras tanto se aceptan tres mensajes mas.
      h.handler.onDisconnect(first)
      first.readyState = 3
      await say(h, writer, 'ana', lobby, 'tres')
      await say(h, writer, 'ana', lobby, 'cuatro')
      await say(h, writer, 'ana', lobby, 'cinco')

      const second = new FakeSocket()
      await subscribe(h, second, 'beto', lobby, { lastSeq: lastSeenByBeto })

      const frame = second.last() as { messages: { seq: number; text: string }[] }

      expect(frame.messages.map((m) => m.text)).toEqual(['tres', 'cuatro', 'cinco'])
      expect(frame.messages.map((m) => m.seq)).toEqual([3, 4, 5])
    })
  })

  describe('resistencia', () => {
    it('un consumidor lento (buffer por encima del limite) se cierra con 1013 y no recibe el mensaje', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const slow = await joinChannel(h, 'lenta', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      slow.bufferedAmount = DEFAULT_MAX_BUFFERED_BYTES + 1

      await say(h, ana, 'ana', lobby, 'hola')

      expect(slow.closeCalls).toEqual([{ code: 1013, reason: 'consumidor_lento' }])
      expect(slow.sent).toEqual([])
      expect(textsOf(beto)).toEqual(['hola'])
      expect(h.logs.some((log) => log.message === 'chat_consumidor_lento')).toBe(true)
    })

    it('frontera: exactamente el limite NO es lento', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const edge = await joinChannel(h, 'borde', lobby)
      edge.bufferedAmount = DEFAULT_MAX_BUFFERED_BYTES

      await say(h, ana, 'ana', lobby, 'hola')

      expect(edge.closeCalls).toEqual([])
      expect(textsOf(edge)).toEqual(['hola'])
    })

    it('el limite es configurable', async () => {
      const h = buildChatHarness({ maxBufferedBytes: 100 })
      const ana = await joinChannel(h, 'ana', lobby)
      const slow = await joinChannel(h, 'lenta', lobby)
      slow.bufferedAmount = 101

      await say(h, ana, 'ana', lobby, 'hola')

      expect(slow.closeCalls[0]?.code).toBe(1013)
    })

    it('un socket cuyo envio lanza NO impide que el resto reciba el mensaje', async () => {
      const h = buildChatHarness()
      const ana = await joinChannel(h, 'ana', lobby)
      const broken = await joinChannel(h, 'rota', lobby)
      const beto = await joinChannel(h, 'beto', lobby)
      broken.failOnSend = new Error('EPIPE')

      await say(h, ana, 'ana', lobby, 'hola')

      expect(textsOf(ana)).toEqual(['hola'])
      expect(textsOf(beto)).toEqual(['hola'])
      expect(h.logs.some((log) => log.message === 'chat_envio_fallo')).toBe(true)
    })
  })

  describe('nombre visible', () => {
    it('Account se consulta UNA vez por conexion, no por mensaje', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100 })
      const ana = await joinChannel(h, 'ana', lobby)

      await say(h, ana, 'ana', lobby, 'uno')
      await say(h, ana, 'ana', lobby, 'dos')
      await say(h, ana, 'ana', lobby, 'tres')

      expect(h.accountCalls).toEqual(['ana'])
    })

    it('una conexion nueva vuelve a consultar Account', async () => {
      const h = buildChatHarness({ rateLimitMessages: 100 })
      const first = await joinChannel(h, 'ana', lobby)
      await say(h, first, 'ana', lobby, 'uno')
      const second = await joinChannel(h, 'ana', lobby)
      await say(h, second, 'ana', lobby, 'dos')

      expect(h.accountCalls).toEqual(['ana', 'ana'])
    })
  })

  describe('tipos no atendidos', () => {
    it('un tipo desconocido no hace nada (el gateway ya lo filtra)', async () => {
      const h = buildChatHarness()
      const socket = new FakeSocket()

      await expect(
        h.handler.handle(socket, 'ana', { type: 'chat.otra-cosa' }),
      ).resolves.toBeUndefined()
      expect(socket.sent).toEqual([])
    })
  })
})
