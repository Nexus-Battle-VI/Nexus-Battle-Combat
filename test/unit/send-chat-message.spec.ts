import { RoomNotFoundError } from '../../src/application/errors/ApplicationError'
import {
  ChatCommandIdReusedError,
  ChatRoomNotActiveError,
  NotARoomParticipantError,
} from '../../src/application/errors/ChatApplicationErrors'
import {
  AccountProfileMissingError,
  UpstreamServiceError,
} from '../../src/application/errors/UpstreamErrors'
import type {
  PreparedChatMessage,
  ReadyChatMessage,
  SendChatMessageInput,
} from '../../src/application/use-cases/SendChatMessage'
import {
  ChatMessageInvalidCharactersError,
  ChatMessageTooLongError,
  ChatRateLimitedError,
  EmptyChatMessageError,
  InvalidChatCommandError,
} from '../../src/domain/errors/ChatErrors'
import {
  LOBBY_CHANNEL,
  chatChannelKey,
  roomChatChannel,
  type ChatChannel,
} from '../../src/domain/value-objects/ChatChannel'
import {
  buildChatHarness,
  cancelRoom,
  createRoom,
  joinRoom,
  uuid,
  type ChatHarness,
} from '../fixtures/chat-harness'

/**
 * Envio de un mensaje (HU-13, RF-13). Cada regla del issue tiene aqui al menos
 * un caso positivo, uno negativo y, cuando hay un limite, uno de frontera
 * (CA-02).
 */
describe('SendChatMessage', () => {
  const ROOM = uuid(1)
  const OTHER_ROOM = uuid(2)
  let counter = 0
  const nextCommandId = (): string => {
    counter += 1

    return uuid(50_000 + counter)
  }

  const input = (over: Partial<SendChatMessageInput> = {}): SendChatMessageInput => ({
    subject: 'ana',
    channel: LOBBY_CHANNEL,
    commandId: nextCommandId(),
    text: 'hola',
    knownDisplayName: null,
    ...over,
  })

  const ready = async (
    harness: ChatHarness,
    over: Partial<SendChatMessageInput> = {},
  ): Promise<ReadyChatMessage> => {
    const prepared: PreparedChatMessage = await harness.sender.prepare(input(over))

    if (prepared.kind !== 'ready') {
      throw new Error('se esperaba un mensaje listo, no un duplicado')
    }

    return prepared
  }

  const send = async (harness: ChatHarness, over: Partial<SendChatMessageInput> = {}) =>
    harness.sender.commit(await ready(harness, over))

  const withRoom = async (harness: ChatHarness): Promise<void> => {
    await createRoom(harness.rooms, ROOM)
    await joinRoom(harness.rooms, ROOM, 'ana', 'Ana')
    await joinRoom(harness.rooms, ROOM, 'beto', null)
  }

  describe('CA-01: flujo principal', () => {
    it('un mensaje del lobby queda aceptado con seq 1, su texto y su remitente', async () => {
      const harness = buildChatHarness()
      const commandId = nextCommandId()

      const { message, duplicate } = await send(harness, { commandId, text: '  hola a todos ' })

      expect(duplicate).toBe(false)
      expect(message).toMatchObject({
        seq: 1,
        senderId: 'ana',
        senderDisplayName: 'nombre-de-ana',
        commandId,
        text: 'hola a todos',
      })
      expect(chatChannelKey(message.channel)).toBe('lobby')
    })

    it('un mensaje de sala de un participante queda aceptado en el canal de esa sala', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)

      const { message } = await send(harness, { channel: roomChatChannel(ROOM) })

      expect(chatChannelKey(message.channel)).toBe(`room:${ROOM}`)
      expect(message.seq).toBe(1)
    })

    it('sentAt es la hora del reloj del servidor, no la del cliente', async () => {
      const harness = buildChatHarness()

      const { message } = await send(harness)

      expect(message.sentAt).toEqual(harness.clock.now())
    })
  })

  describe('quien puede escribir (RF-13: sala activa, participantes de esa sala)', () => {
    it('cualquier identidad puede escribir en el lobby', async () => {
      const harness = buildChatHarness()

      await expect(send(harness, { subject: 'nadie-en-particular' })).resolves.toBeDefined()
    })

    it('un jugador que no esta en la sala no puede escribir en ella', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)

      await expect(
        harness.sender.prepare(input({ subject: 'intruso', channel: roomChatChannel(ROOM) })),
      ).rejects.toBeInstanceOf(NotARoomParticipantError)
    })

    it('un participante de la sala A no puede escribir en la sala B', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)
      await createRoom(harness.rooms, OTHER_ROOM)
      await joinRoom(harness.rooms, OTHER_ROOM, 'carla', 'Carla')

      await expect(
        harness.sender.prepare(input({ subject: 'ana', channel: roomChatChannel(OTHER_ROOM) })),
      ).rejects.toBeInstanceOf(NotARoomParticipantError)
    })

    it('una sala inexistente se rechaza', async () => {
      const harness = buildChatHarness()

      await expect(
        harness.sender.prepare(input({ channel: roomChatChannel(uuid(404)) })),
      ).rejects.toBeInstanceOf(RoomNotFoundError)
    })

    it('una sala cancelada no admite mensajes', async () => {
      const harness = buildChatHarness()
      await createRoom(harness.rooms, ROOM, 'creador')
      await joinRoom(harness.rooms, ROOM, 'ana', 'Ana')
      await cancelRoom(harness.rooms, ROOM, 'creador')

      await expect(
        harness.sender.prepare(input({ channel: roomChatChannel(ROOM) })),
      ).rejects.toBeInstanceOf(ChatRoomNotActiveError)
    })

    it('la autorizacion se decide antes de mirar el texto: un ajeno no aprende nada del texto', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)

      await expect(
        harness.sender.prepare(
          input({ subject: 'intruso', channel: roomChatChannel(ROOM), text: '' }),
        ),
      ).rejects.toBeInstanceOf(NotARoomParticipantError)
    })
  })

  describe('validaciones del texto', () => {
    it('un mensaje vacio o solo de espacios se rechaza', async () => {
      const harness = buildChatHarness()

      await expect(harness.sender.prepare(input({ text: '' }))).rejects.toBeInstanceOf(
        EmptyChatMessageError,
      )
      await expect(harness.sender.prepare(input({ text: '    ' }))).rejects.toBeInstanceOf(
        EmptyChatMessageError,
      )
    })

    it('frontera: exactamente el maximo configurado se acepta y uno mas se rechaza', async () => {
      const harness = buildChatHarness({ maxMessageLength: 10 })

      await expect(send(harness, { text: 'a'.repeat(10) })).resolves.toBeDefined()
      await expect(harness.sender.prepare(input({ text: 'a'.repeat(11) }))).rejects.toBeInstanceOf(
        ChatMessageTooLongError,
      )
    })

    it('el maximo por defecto es 500', async () => {
      const harness = buildChatHarness({ rateLimitMessages: 100 })

      await expect(send(harness, { text: 'a'.repeat(500) })).resolves.toBeDefined()
      await expect(harness.sender.prepare(input({ text: 'a'.repeat(501) }))).rejects.toBeInstanceOf(
        ChatMessageTooLongError,
      )
    })

    it('un caracter de control se rechaza', async () => {
      const harness = buildChatHarness()

      await expect(harness.sender.prepare(input({ text: 'a\u0000b' }))).rejects.toBeInstanceOf(
        ChatMessageInvalidCharactersError,
      )
    })

    it('un texto que no es cadena es un comando invalido', async () => {
      const harness = buildChatHarness()

      await expect(harness.sender.prepare(input({ text: 42 }))).rejects.toBeInstanceOf(
        InvalidChatCommandError,
      )
    })

    it.each([
      ['ausente', undefined],
      ['numerico', 12345],
      ['nulo', null],
      ['sin forma de UUID', 'no-es-un-uuid'],
      ['UUID incompleto', '00000000-0000-4000-8000'],
      ['vacio', ''],
    ])('un commandId %s es un comando invalido', async (_label, commandId) => {
      const harness = buildChatHarness()

      await expect(harness.sender.prepare(input({ commandId }))).rejects.toBeInstanceOf(
        InvalidChatCommandError,
      )
    })
  })

  describe('procesado una sola vez (RF-13, ADR-020: commandId)', () => {
    it('repetir el mismo commandId devuelve el mensaje YA aceptado, sin crear otro', async () => {
      const harness = buildChatHarness()
      const commandId = nextCommandId()

      const first = await send(harness, { commandId })
      const retry = await harness.sender.prepare(input({ commandId }))

      expect(retry.kind).toBe('duplicate')
      expect(retry.kind === 'duplicate' && retry.message).toEqual(first.message)

      const page = await harness.readHistory.execute(LOBBY_CHANNEL, null)

      expect(page.messages).toHaveLength(1)
    })

    it('un reintento con OTRO texto sigue devolviendo el primer mensaje, no crea uno nuevo', async () => {
      const harness = buildChatHarness()
      const commandId = nextCommandId()

      await send(harness, { commandId, text: 'primero' })
      const retry = await harness.sender.prepare(input({ commandId, text: 'segundo' }))

      expect(retry.kind === 'duplicate' && retry.message.text).toBe('primero')
    })

    it('el commandId en mayusculas es el mismo comando que en minusculas', async () => {
      const harness = buildChatHarness()
      const commandId = 'abcdef00-0000-4000-8000-000000000001'

      await send(harness, { commandId })
      const retry = await harness.sender.prepare(input({ commandId: commandId.toUpperCase() }))

      expect(retry.kind).toBe('duplicate')
    })

    it('el reintento NO gasta cupo de frecuencia', async () => {
      const harness = buildChatHarness({ rateLimitMessages: 2 })
      const commandId = nextCommandId()

      await send(harness, { commandId })
      await send(harness)

      // Cupo agotado; pero repetir el primer comando no es un mensaje nuevo.
      for (let i = 0; i < 5; i += 1) {
        const retry = await harness.sender.prepare(input({ commandId }))

        expect(retry.kind).toBe('duplicate')
      }
    })

    it('el mismo commandId de OTRO remitente es otro comando', async () => {
      const harness = buildChatHarness()
      const commandId = nextCommandId()

      const ana = await send(harness, { subject: 'ana', commandId })
      const beto = await send(harness, { subject: 'beto', commandId })

      expect(beto.duplicate).toBe(false)
      expect(beto.message.id).not.toBe(ana.message.id)
      expect([ana.message.seq, beto.message.seq]).toEqual([1, 2])
    })

    it('el mismo remitente con commandId distinto envia mensajes distintos', async () => {
      const harness = buildChatHarness()

      const first = await send(harness)
      const second = await send(harness)

      expect([first.message.seq, second.message.seq]).toEqual([1, 2])
    })

    it('reutilizar un commandId en OTRO canal es un error, no un duplicado', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)
      const commandId = nextCommandId()

      await send(harness, { commandId, channel: LOBBY_CHANNEL })

      await expect(
        harness.sender.prepare(input({ commandId, channel: roomChatChannel(ROOM) })),
      ).rejects.toBeInstanceOf(ChatCommandIdReusedError)
    })

    it('dos comandos identicos en vuelo: el segundo commit devuelve el duplicado', async () => {
      const harness = buildChatHarness()
      const commandId = nextCommandId()

      // Ambos pasan `prepare` antes de que ninguno persista (dos pestanas, o un doble clic).
      const a = await ready(harness, { commandId })
      const b = await ready(harness, { commandId })

      const first = await harness.sender.commit(a)
      const second = await harness.sender.commit(b)

      expect(first.duplicate).toBe(false)
      expect(second.duplicate).toBe(true)
      expect(second.message.id).toBe(first.message.id)
      expect((await harness.readHistory.execute(LOBBY_CHANNEL, null)).messages).toHaveLength(1)
    })

    it('dos comandos identicos en vuelo hacia canales distintos: el segundo es un error', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)
      const commandId = nextCommandId()

      const lobby = await ready(harness, { commandId, channel: LOBBY_CHANNEL })
      const room = await ready(harness, { commandId, channel: roomChatChannel(ROOM) })

      await harness.sender.commit(lobby)

      await expect(harness.sender.commit(room)).rejects.toBeInstanceOf(ChatCommandIdReusedError)
    })
  })

  describe('frecuencia (por remitente y canal)', () => {
    it('permite hasta el maximo (5) y rechaza el siguiente con el tiempo de espera', async () => {
      const harness = buildChatHarness()

      for (let i = 0; i < 5; i += 1) {
        await send(harness)
      }

      const rejected = harness.sender.prepare(input())

      await expect(rejected).rejects.toBeInstanceOf(ChatRateLimitedError)
      await expect(rejected).rejects.toMatchObject({ retryAfterMs: 10_000 })
    })

    it('el mensaje rechazado por frecuencia NO se persiste', async () => {
      const harness = buildChatHarness({ rateLimitMessages: 1 })

      await send(harness)
      await expect(harness.sender.prepare(input())).rejects.toBeInstanceOf(ChatRateLimitedError)

      expect((await harness.readHistory.execute(LOBBY_CHANNEL, null)).messages).toHaveLength(1)
    })

    it('frontera: pasada la ventana (10 s) el remitente puede volver a escribir', async () => {
      const harness = buildChatHarness()

      for (let i = 0; i < 5; i += 1) {
        await send(harness)
      }

      harness.clock.advance(9_999)
      await expect(harness.sender.prepare(input())).rejects.toBeInstanceOf(ChatRateLimitedError)

      harness.clock.advance(1)
      await expect(send(harness)).resolves.toBeDefined()
    })

    it('el limite es por remitente: otro jugador no queda bloqueado', async () => {
      const harness = buildChatHarness({ rateLimitMessages: 1 })

      await send(harness, { subject: 'ana' })

      await expect(send(harness, { subject: 'beto' })).resolves.toBeDefined()
    })

    it('el limite es por canal: el mismo remitente escribe en la sala aunque agoto el lobby', async () => {
      const harness = buildChatHarness({ rateLimitMessages: 1 })
      await withRoom(harness)

      await send(harness, { channel: LOBBY_CHANNEL })
      await expect(
        harness.sender.prepare(input({ channel: LOBBY_CHANNEL })),
      ).rejects.toBeInstanceOf(ChatRateLimitedError)

      await expect(send(harness, { channel: roomChatChannel(ROOM) })).resolves.toBeDefined()
    })

    it('un mensaje invalido NO consume cupo', async () => {
      const harness = buildChatHarness({ rateLimitMessages: 1 })

      for (let i = 0; i < 10; i += 1) {
        await expect(harness.sender.prepare(input({ text: '' }))).rejects.toBeInstanceOf(
          EmptyChatMessageError,
        )
      }

      await expect(send(harness)).resolves.toBeDefined()
    })

    it('un fallo de Account NO consume cupo', async () => {
      let fail = true
      const harness = buildChatHarness({
        rateLimitMessages: 1,
        accountProfiles: {
          getBattleProfile: (subject) =>
            fail
              ? Promise.reject(new UpstreamServiceError('account', 'no_alcanzable'))
              : Promise.resolve({ subject, displayName: 'Ana', avatarUrl: null }),
        },
      })

      await expect(harness.sender.prepare(input())).rejects.toBeInstanceOf(UpstreamServiceError)

      fail = false
      await expect(send(harness)).resolves.toBeDefined()
    })
  })

  describe('nombre visible del remitente (nunca lo elige el cliente)', () => {
    it('en una sala usa el nombre con el que el participante se unio, sin consultar Account', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)

      const { message } = await send(harness, { subject: 'ana', channel: roomChatChannel(ROOM) })

      expect(message.senderDisplayName).toBe('Ana')
      expect(harness.accountCalls).toEqual([])
    })

    it('un participante sin nombre en la sala se resuelve en Account', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)

      const { message } = await send(harness, { subject: 'beto', channel: roomChatChannel(ROOM) })

      expect(message.senderDisplayName).toBe('nombre-de-beto')
      expect(harness.accountCalls).toEqual(['beto'])
    })

    it('en el lobby se resuelve en Account', async () => {
      const harness = buildChatHarness()

      const { message } = await send(harness, { subject: 'ana' })

      expect(message.senderDisplayName).toBe('nombre-de-ana')
    })

    it('un nombre ya conocido en la conexion se reutiliza sin llamar a Account', async () => {
      const harness = buildChatHarness()

      const { message } = await send(harness, { knownDisplayName: 'Ana del cache' })

      expect(message.senderDisplayName).toBe('Ana del cache')
      expect(harness.accountCalls).toEqual([])
    })

    it('informa del nombre obtenido de Account para que la conexion lo recuerde', async () => {
      const harness = buildChatHarness()

      expect((await ready(harness)).resolvedAccountDisplayName).toBe('nombre-de-ana')
      expect(
        (await ready(harness, { knownDisplayName: 'cache' })).resolvedAccountDisplayName,
      ).toBeNull()
    })

    it('el nombre de la sala se prefiere al recordado', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)

      const { message } = await send(harness, {
        subject: 'ana',
        channel: roomChatChannel(ROOM),
        knownDisplayName: 'cache',
      })

      expect(message.senderDisplayName).toBe('Ana')
    })

    it('un sujeto sin cuenta en Account no puede escribir en el lobby', async () => {
      const harness = buildChatHarness({
        accountProfiles: {
          getBattleProfile: (subject) => Promise.reject(new AccountProfileMissingError(subject)),
        },
      })

      await expect(harness.sender.prepare(input())).rejects.toBeInstanceOf(
        AccountProfileMissingError,
      )
    })
  })

  describe('persistencia', () => {
    it('`prepare` no persiste nada', async () => {
      const harness = buildChatHarness()

      await harness.sender.prepare(input())

      expect((await harness.readHistory.execute(LOBBY_CHANNEL, null)).messages).toEqual([])
    })

    it('seq es contiguo por canal y cada canal cuenta aparte', async () => {
      const harness = buildChatHarness({ rateLimitMessages: 100 })
      await withRoom(harness)
      await createRoom(harness.rooms, OTHER_ROOM)
      await joinRoom(harness.rooms, OTHER_ROOM, 'ana', 'Ana')

      const lobby = [await send(harness), await send(harness), await send(harness)]
      const roomA = await send(harness, { channel: roomChatChannel(ROOM) })
      const roomB = await send(harness, { channel: roomChatChannel(OTHER_ROOM) })

      expect(lobby.map((r) => r.message.seq)).toEqual([1, 2, 3])
      expect(roomA.message.seq).toBe(1)
      expect(roomB.message.seq).toBe(1)
    })

    it('el mensaje caduca tras la retencion configurada', async () => {
      const harness = buildChatHarness({ retentionMs: 3_600_000 })
      const before = harness.clock.now().getTime()

      await send(harness)

      harness.clock.advance(3_599_999)
      expect((await harness.readHistory.execute(LOBBY_CHANNEL, null)).messages).toHaveLength(1)

      harness.clock.set(new Date(before + 3_600_000))
      expect((await harness.readHistory.execute(LOBBY_CHANNEL, null)).messages).toHaveLength(0)
    })

    it('los canales no se mezclan: un mensaje de la sala no aparece en el lobby', async () => {
      const harness = buildChatHarness()
      await withRoom(harness)

      await send(harness, { channel: roomChatChannel(ROOM), text: 'solo sala' })

      expect((await harness.readHistory.execute(LOBBY_CHANNEL, null)).messages).toEqual([])
      const roomPage = await harness.readHistory.execute(roomChatChannel(ROOM), null)

      expect(roomPage.messages.map((m) => m.text)).toEqual(['solo sala'])
    })
  })

  describe('canal y tipos', () => {
    it.each<[string, ChatChannel]>([
      ['lobby', LOBBY_CHANNEL],
      ['sala', roomChatChannel(ROOM)],
    ])('el mensaje aceptado conserva el canal (%s)', async (_label, channel) => {
      const harness = buildChatHarness()
      await withRoom(harness)

      const { message } = await send(harness, { channel })

      expect(message.channel).toEqual(channel)
    })
  })
})
