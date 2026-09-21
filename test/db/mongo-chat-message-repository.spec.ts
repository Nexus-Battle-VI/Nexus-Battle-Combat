import 'reflect-metadata'

import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { Int32, MongoServerError, type Collection, type Db, type MongoClient } from 'mongodb'

import {
  CHAT_CHANNELS_COLLECTION,
  CHAT_MESSAGES_COLLECTION,
  MongoChatMessageRepository,
} from '../../src/adapters/outbound/persistence/MongoChatMessageRepository'
import type { ChatMessageDraft } from '../../src/application/ports/ChatMessageRepositoryPort'
import { LOBBY_CHANNEL, roomChatChannel } from '../../src/domain/value-objects/ChatChannel'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'

/**
 * Persistencia del chat contra un MongoDB REAL, en contenedor (HU-13, RF-13).
 *
 * Comprueba lo que un doble no puede: que la migracion `006` cree las
 * colecciones, el validador `$jsonSchema` y los indices UNICOS y TTL de verdad;
 * que el contador de `seq` sea atomico bajo concurrencia; y que la idempotencia
 * descanse en el indice unico del motor.
 */
describe('MongoChatMessageRepository', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db
  let repository: MongoChatMessageRepository

  const NOW = new Date('2026-09-20T12:00:00.000Z')
  const HOUR = 3_600_000
  let counter = 0

  const nextId = (): string => {
    counter += 1

    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
  }

  let channelCounter = 0
  /** Cada prueba usa su propia sala: no dependen del orden ni se pisan. */
  const freshChannel = () => {
    channelCounter += 1

    return roomChatChannel(`11111111-1111-4111-8111-${String(channelCounter).padStart(12, '0')}`)
  }

  const draft = (over: Partial<ChatMessageDraft> = {}): ChatMessageDraft => ({
    id: nextId(),
    channel: LOBBY_CHANNEL,
    senderId: 'sujeto-ana',
    senderDisplayName: 'Ana',
    commandId: nextId(),
    text: 'hola',
    sentAt: NOW,
    expiresAt: new Date(NOW.getTime() + HOUR),
    ...over,
  })

  const messages = (): Collection<Record<string, unknown> & { _id: string }> =>
    db.collection<Record<string, unknown> & { _id: string }>(CHAT_MESSAGES_COLLECTION)

  const channels = (): Collection<Record<string, unknown> & { _id: string }> =>
    db.collection<Record<string, unknown> & { _id: string }>(CHAT_CHANNELS_COLLECTION)

  /** Documento valido a nivel de motor, para insertar directamente y ejercitar el validador. */
  const rawDoc = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> & { _id: string } => ({
    _id: nextId(),
    channelKey: 'lobby',
    seq: new Int32(1),
    senderId: 'sujeto-ana',
    senderDisplayName: 'Ana',
    commandId: nextId(),
    text: 'hola',
    sentAt: NOW,
    expiresAt: new Date(NOW.getTime() + HOUR),
    ...over,
  })

  const expectEngineError = async (action: Promise<unknown>, code: number): Promise<void> => {
    try {
      await action
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(MongoServerError)
      expect((error as MongoServerError).code).toBe(code)

      return
    }

    throw new Error(`Se esperaba un error del motor (${String(code)}) y no hubo ninguno`)
  }

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)

    const { error } = await migrateToLatest(db)

    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }

    repository = new MongoChatMessageRepository(db)
  }, 180_000)

  afterAll(async () => {
    await client.close()
    await container.stop()
  })

  describe('migracion 006', () => {
    it('crea las dos colecciones', async () => {
      const names = (await db.listCollections().toArray()).map((c) => c.name)

      expect(names).toEqual(
        expect.arrayContaining([CHAT_MESSAGES_COLLECTION, CHAT_CHANNELS_COLLECTION]),
      )
    })

    it('crea el indice UNICO (channelKey, seq)', async () => {
      const index = (await messages().indexes()).find((i) => i.name === 'channelKey_1_seq_1')

      expect(index).toMatchObject({ key: { channelKey: 1, seq: 1 }, unique: true })
    })

    it('crea el indice UNICO (senderId, commandId)', async () => {
      const index = (await messages().indexes()).find((i) => i.name === 'senderId_1_commandId_1')

      expect(index).toMatchObject({ key: { senderId: 1, commandId: 1 }, unique: true })
    })

    it('crea el indice TTL sobre expiresAt con expireAfterSeconds 0', async () => {
      const index = (await messages().indexes()).find((i) => i.name === 'expiresAt_ttl')

      expect(index).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 })
    })

    it('el TTL NO se aplica al contador: la numeracion no se reinicia', async () => {
      const indexes = await channels().indexes()

      expect(indexes.some((i) => 'expireAfterSeconds' in i)).toBe(false)
    })

    it('es idempotente: aplicarla otra vez no cambia nada', async () => {
      const { applied, error } = await migrateToLatest(db)

      expect(error).toBeUndefined()
      expect(applied).toEqual([])
    })
  })

  describe('validador $jsonSchema de chat-messages (additionalProperties: false)', () => {
    const DOCUMENT_VALIDATION_FAILURE = 121

    it('acepta un documento valido', async () => {
      await expect(
        messages().insertOne(rawDoc({ channelKey: 'lobby', seq: new Int32(900) })),
      ).resolves.toBeDefined()
    })

    it.each([
      ['un campo no declarado', { extra: 'x' }],
      ['texto vacio', { text: '' }],
      ['texto de mas de 8000', { text: 'a'.repeat(8001) }],
      ['seq 0', { seq: new Int32(0) }],
      ['seq negativo', { seq: new Int32(-1) }],
      ['seq que no es entero', { seq: 1.5 }],
      ['senderId vacio', { senderId: '' }],
      ['senderId no string', { senderId: 7 }],
      ['commandId vacio', { commandId: '' }],
      ['commandId de mas de 64', { commandId: 'a'.repeat(65) }],
      ['nombre visible vacio', { senderDisplayName: '' }],
      ['sentAt que no es fecha', { sentAt: 'ayer' }],
      ['expiresAt que no es fecha', { expiresAt: 12345 }],
      ['channelKey vacio', { channelKey: '' }],
    ])('rechaza %s', async (_label, over) => {
      await expectEngineError(
        messages().insertOne(rawDoc({ ...over, seq: 'seq' in over ? over.seq : new Int32(500) })),
        DOCUMENT_VALIDATION_FAILURE,
      )
    })

    it.each([
      '_id',
      'channelKey',
      'seq',
      'senderId',
      'senderDisplayName',
      'commandId',
      'text',
      'sentAt',
      'expiresAt',
    ])('rechaza un documento sin %s', async (field) => {
      const doc = rawDoc({ seq: new Int32(600) })

      Reflect.deleteProperty(doc, field)
      // Sin `_id` el driver genera un ObjectId, que el validador tambien rechaza (bsonType string).
      await expectEngineError(messages().insertOne(doc), DOCUMENT_VALIDATION_FAILURE)
    })

    it('un texto de 500 puntos de codigo con emojis (2000 bytes) cabe en el validador', async () => {
      const text = '\u{1F600}'.repeat(500)

      await expect(
        messages().insertOne(rawDoc({ seq: new Int32(700), text })),
      ).resolves.toBeDefined()
    })

    it('el validador de chat-channels rechaza campos extra y seq negativo', async () => {
      await expectEngineError(
        channels().insertOne({ _id: 'x', seq: new Int32(1), extra: 1 }),
        DOCUMENT_VALIDATION_FAILURE,
      )
      await expectEngineError(
        channels().insertOne({ _id: 'y', seq: new Int32(-1) }),
        DOCUMENT_VALIDATION_FAILURE,
      )
    })
  })

  describe('indices unicos del motor', () => {
    const DUPLICATE_KEY = 11000

    it('(channelKey, seq) repetido lo rechaza el motor', async () => {
      await messages().insertOne(rawDoc({ channelKey: 'room:aaaa', seq: new Int32(1) }))

      await expectEngineError(
        messages().insertOne(rawDoc({ channelKey: 'room:aaaa', seq: new Int32(1) })),
        DUPLICATE_KEY,
      )
    })

    it('el mismo seq en OTRO canal si es valido', async () => {
      await messages().insertOne(rawDoc({ channelKey: 'room:bbbb', seq: new Int32(1) }))

      await expect(
        messages().insertOne(rawDoc({ channelKey: 'room:cccc', seq: new Int32(1) })),
      ).resolves.toBeDefined()
    })

    it('(senderId, commandId) repetido lo rechaza el motor', async () => {
      const commandId = nextId()

      await messages().insertOne(rawDoc({ channelKey: 'room:dddd', seq: new Int32(1), commandId }))

      await expectEngineError(
        messages().insertOne(rawDoc({ channelKey: 'room:dddd', seq: new Int32(2), commandId })),
        DUPLICATE_KEY,
      )
    })
  })

  describe('append', () => {
    it('devuelve el mensaje con seq 1, 2, 3... contiguos y como numero', async () => {
      const channel = freshChannel()

      const seqs = []
      for (let i = 0; i < 4; i += 1) {
        seqs.push((await repository.append(draft({ channel }))).message.seq)
      }

      expect(seqs).toEqual([1, 2, 3, 4])
      expect(typeof seqs[0]).toBe('number')
    })

    it('cada canal cuenta aparte', async () => {
      const a = freshChannel()
      const b = freshChannel()

      await repository.append(draft({ channel: a }))
      await repository.append(draft({ channel: a }))
      const first = await repository.append(draft({ channel: b }))

      expect(first.message.seq).toBe(1)
    })

    it('persiste todos los campos sin alterarlos (emoji, acentos, fechas al milisegundo)', async () => {
      const channel = freshChannel()
      const input = draft({
        channel,
        text: '¿Jugamos? ñandú \u{1F600} <b>x</b>',
        senderDisplayName: 'Ánä',
        sentAt: new Date('2026-09-20T12:34:56.789Z'),
        expiresAt: new Date('2026-09-27T12:34:56.789Z'),
      })

      const { message } = await repository.append(input)
      const stored = await messages().findOne({ _id: input.id })

      expect(message).toMatchObject({
        id: input.id,
        senderId: 'sujeto-ana',
        senderDisplayName: 'Ánä',
        commandId: input.commandId,
        text: '¿Jugamos? ñandú \u{1F600} <b>x</b>',
      })
      expect(stored?.expiresAt).toEqual(new Date('2026-09-27T12:34:56.789Z'))
      expect(stored?.sentAt).toEqual(new Date('2026-09-20T12:34:56.789Z'))
      expect(stored?.channelKey).toBe(`room:${(channel as { roomId: string }).roomId}`)
    })

    it('40 escrituras CONCURRENTES al mismo canal reciben 40 seq distintos, del 1 al 40', async () => {
      const channel = freshChannel()

      const results = await Promise.all(
        Array.from({ length: 40 }, () => repository.append(draft({ channel }))),
      )

      const seqs = results.map((r) => r.message.seq).sort((x, y) => x - y)

      expect(seqs).toEqual(Array.from({ length: 40 }, (_v, i) => i + 1))
      expect(
        await messages().countDocuments({
          channelKey: `room:${(channel as { roomId: string }).roomId}`,
        }),
      ).toBe(40)
    })

    describe('idempotencia por (senderId, commandId)', () => {
      it('repetir el comando devuelve el mensaje ya aceptado y no crea otro documento', async () => {
        const channel = freshChannel()
        const commandId = nextId()

        const first = await repository.append(draft({ channel, commandId, text: 'primero' }))
        const again = await repository.append(draft({ channel, commandId, text: 'segundo' }))

        expect(first.duplicate).toBe(false)
        expect(again.duplicate).toBe(true)
        expect(again.message.id).toBe(first.message.id)
        expect(again.message.text).toBe('primero')
        expect(await messages().countDocuments({ commandId })).toBe(1)
      })

      it('dos comandos identicos A LA VEZ producen un solo mensaje', async () => {
        const channel = freshChannel()
        const commandId = nextId()

        const [x, y] = await Promise.all([
          repository.append(draft({ channel, commandId })),
          repository.append(draft({ channel, commandId })),
        ])

        expect([x.duplicate, y.duplicate].sort()).toEqual([false, true])
        expect(x.message.id).toBe(y.message.id)
        expect(await messages().countDocuments({ commandId })).toBe(1)
      })

      it('el mismo commandId con otro remitente es otro mensaje', async () => {
        const channel = freshChannel()
        const commandId = nextId()

        await repository.append(draft({ channel, commandId, senderId: 'sujeto-ana' }))
        const beto = await repository.append(draft({ channel, commandId, senderId: 'sujeto-beto' }))

        expect(beto.duplicate).toBe(false)
      })

      it('un duplicado deja un HUECO en seq (numero reservado): el siguiente salta uno, y upTo lo cubre', async () => {
        const channel = freshChannel()
        const commandId = nextId()

        await repository.append(draft({ channel, commandId })) // seq 1
        await repository.append(draft({ channel, commandId })) // reserva 2, choca, devuelve el 1
        const next = await repository.append(draft({ channel })) // seq 3

        expect(next.message.seq).toBe(3)

        const page = await repository.readHistory(channel, { afterSeq: null, limit: 50, now: NOW })

        expect(page.messages.map((m) => m.seq)).toEqual([1, 3])
        expect(page.upTo).toBe(3)
      })
    })

    describe('choque de seq (ultima defensa si hubiera dos escritores)', () => {
      it('reintenta con otro numero y termina aceptando el mensaje', async () => {
        const channel = freshChannel()
        const key = `room:${(channel as { roomId: string }).roomId}`

        // Alguien ocupo el seq 1 sin pasar por el contador.
        await messages().insertOne(rawDoc({ channelKey: key, seq: new Int32(1) }))

        const { message } = await repository.append(draft({ channel }))

        expect(message.seq).toBe(2)
      })

      it('tras 3 choques seguidos no reintenta mas y falla', async () => {
        const channel = freshChannel()
        const key = `room:${(channel as { roomId: string }).roomId}`

        for (const seq of [1, 2, 3]) {
          await messages().insertOne(rawDoc({ channelKey: key, seq: new Int32(seq) }))
        }

        await expectEngineError(repository.append(draft({ channel })), 11000)
      })
    })
  })

  describe('findByCommand', () => {
    it('encuentra el mensaje por (remitente, comando)', async () => {
      const commandId = nextId()
      const { message } = await repository.append(draft({ channel: freshChannel(), commandId }))

      await expect(repository.findByCommand('sujeto-ana', commandId)).resolves.toEqual(message)
    })

    it('null para otro remitente o un comando desconocido', async () => {
      const commandId = nextId()
      await repository.append(draft({ channel: freshChannel(), commandId }))

      await expect(repository.findByCommand('sujeto-beto', commandId)).resolves.toBeNull()
      await expect(repository.findByCommand('sujeto-ana', nextId())).resolves.toBeNull()
    })
  })

  describe('readHistory', () => {
    const fill = async (channel = freshChannel(), count = 5) => {
      for (let i = 0; i < count; i += 1) {
        await repository.append(draft({ channel, text: `m${String(i + 1)}` }))
      }

      return channel
    }

    it('un canal sin mensajes: vacio, upTo 0, sin truncar', async () => {
      await expect(
        repository.readHistory(freshChannel(), { afterSeq: null, limit: 50, now: NOW }),
      ).resolves.toEqual({ messages: [], upTo: 0, truncated: false })
    })

    it('devuelve los mensajes en orden ascendente de seq con upTo', async () => {
      const channel = await fill()

      const page = await repository.readHistory(channel, { afterSeq: null, limit: 50, now: NOW })

      expect(page.messages.map((m) => m.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
      expect(page.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
      expect(page.upTo).toBe(5)
      expect(page.truncated).toBe(false)
    })

    it('afterSeq = 3 excluye el 3 (frontera)', async () => {
      const channel = await fill()

      const page = await repository.readHistory(channel, { afterSeq: 3, limit: 50, now: NOW })

      expect(page.messages.map((m) => m.seq)).toEqual([4, 5])
    })

    it('frontera de limite: exactamente `limit` no es truncado; `limit + 1` si, y quedan los mas recientes', async () => {
      const channel = await fill(freshChannel(), 6)

      const exact = await repository.readHistory(channel, { afterSeq: 1, limit: 5, now: NOW })
      const over = await repository.readHistory(channel, { afterSeq: null, limit: 5, now: NOW })

      expect(exact.truncated).toBe(false)
      expect(exact.messages).toHaveLength(5)
      expect(over.truncated).toBe(true)
      expect(over.messages.map((m) => m.seq)).toEqual([2, 3, 4, 5, 6])
    })

    it('no incluye lo expirado aunque el motor aun no lo haya purgado (expiresAt <= now)', async () => {
      const channel = freshChannel()

      await repository.append(
        draft({ channel, text: 'vence pronto', expiresAt: new Date(NOW.getTime() + 1_000) }),
      )
      await repository.append(draft({ channel, text: 'vigente' }))

      const before = await repository.readHistory(channel, {
        afterSeq: null,
        limit: 50,
        now: new Date(NOW.getTime() + 999),
      })
      const atExpiry = await repository.readHistory(channel, {
        afterSeq: null,
        limit: 50,
        now: new Date(NOW.getTime() + 1_000),
      })

      expect(before.messages.map((m) => m.text)).toEqual(['vence pronto', 'vigente'])
      expect(atExpiry.messages.map((m) => m.text)).toEqual(['vigente'])
    })

    it('la numeracion NO se reinicia aunque se purguen todos los mensajes (el contador vive aparte)', async () => {
      const channel = await fill(freshChannel(), 3)
      const key = `room:${(channel as { roomId: string }).roomId}`

      // Lo que hace el TTL al purgar: desaparecen los mensajes, no el contador.
      await messages().deleteMany({ channelKey: key })

      const page = await repository.readHistory(channel, { afterSeq: null, limit: 50, now: NOW })
      const next = await repository.append(draft({ channel }))

      expect(page).toEqual({ messages: [], upTo: 3, truncated: false })
      expect(next.message.seq).toBe(4)
    })

    it('el historial de un canal no contiene mensajes de otro', async () => {
      const a = await fill(freshChannel(), 2)
      const b = await fill(freshChannel(), 3)

      const pageA = await repository.readHistory(a, { afterSeq: null, limit: 50, now: NOW })
      const pageB = await repository.readHistory(b, { afterSeq: null, limit: 50, now: NOW })

      expect(pageA.messages).toHaveLength(2)
      expect(pageB.messages).toHaveLength(3)
    })

    it('el lobby y las salas tienen historiales separados', async () => {
      const room = await fill(freshChannel(), 1)
      await repository.append(draft({ channel: LOBBY_CHANNEL, text: 'solo del lobby' }))

      const roomPage = await repository.readHistory(room, { afterSeq: null, limit: 50, now: NOW })
      const lobbyPage = await repository.readHistory(LOBBY_CHANNEL, {
        afterSeq: null,
        limit: 500,
        now: NOW,
      })

      expect(roomPage.messages.map((m) => m.text)).toEqual(['m1'])
      expect(lobbyPage.messages.map((m) => m.text)).toContain('solo del lobby')
      expect(lobbyPage.messages.map((m) => m.text)).not.toContain('m1')
    })
  })
})
