import { InMemoryChatMessageRepository } from '../../src/adapters/outbound/persistence/InMemoryChatMessageRepository'
import type { ChatMessageDraft } from '../../src/application/ports/ChatMessageRepositoryPort'
import { LOBBY_CHANNEL, roomChatChannel } from '../../src/domain/value-objects/ChatChannel'
import { uuid } from '../fixtures/chat-harness'

/**
 * Historial y persistencia del chat (HU-13, RF-13: «la entrega no debe
 * perderse»). Se prueba contra el repositorio en memoria, que reproduce el
 * contrato del puerto; el adaptador de MongoDB lo prueba `test/db`.
 */
describe('ChatMessageRepositoryPort (en memoria)', () => {
  const NOW = new Date('2026-09-20T12:00:00.000Z')
  const HOUR = 3_600_000
  let n = 0

  const draft = (over: Partial<ChatMessageDraft> = {}): ChatMessageDraft => {
    n += 1

    return {
      id: uuid(n),
      channel: LOBBY_CHANNEL,
      senderId: 'ana',
      senderDisplayName: 'Ana',
      commandId: uuid(10_000 + n),
      text: `mensaje ${String(n)}`,
      sentAt: NOW,
      expiresAt: new Date(NOW.getTime() + HOUR),
      ...over,
    }
  }

  const fill = async (repo: InMemoryChatMessageRepository, count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      await repo.append(draft())
    }
  }

  describe('append', () => {
    it('asigna seq 1, 2, 3... contiguos por canal', async () => {
      const repo = new InMemoryChatMessageRepository()

      const seqs = []
      for (let i = 0; i < 4; i += 1) {
        seqs.push((await repo.append(draft())).message.seq)
      }

      expect(seqs).toEqual([1, 2, 3, 4])
    })

    it('cada canal tiene su propia secuencia', async () => {
      const repo = new InMemoryChatMessageRepository()
      const roomA = roomChatChannel(uuid(1))
      const roomB = roomChatChannel(uuid(2))

      await repo.append(draft())
      await repo.append(draft({ channel: roomA }))
      await repo.append(draft({ channel: roomA }))
      const b = await repo.append(draft({ channel: roomB }))
      const lobby = await repo.append(draft())

      expect(b.message.seq).toBe(1)
      expect(lobby.message.seq).toBe(2)
    })

    it('un (senderId, commandId) repetido devuelve el existente y no consume seq', async () => {
      const repo = new InMemoryChatMessageRepository()
      const commandId = uuid(777)

      const first = await repo.append(draft({ commandId }))
      const again = await repo.append(draft({ commandId, text: 'otro texto' }))
      const next = await repo.append(draft())

      expect(again.duplicate).toBe(true)
      expect(again.message).toEqual(first.message)
      expect(next.message.seq).toBe(2)
    })

    it('el mismo commandId con otro remitente no es duplicado', async () => {
      const repo = new InMemoryChatMessageRepository()
      const commandId = uuid(777)

      await repo.append(draft({ commandId, senderId: 'ana' }))
      const beto = await repo.append(draft({ commandId, senderId: 'beto' }))

      expect(beto.duplicate).toBe(false)
    })
  })

  describe('findByCommand', () => {
    it('encuentra el mensaje aceptado para ese comando', async () => {
      const repo = new InMemoryChatMessageRepository()
      const commandId = uuid(5)
      const { message } = await repo.append(draft({ commandId }))

      await expect(repo.findByCommand('ana', commandId)).resolves.toEqual(message)
    })

    it('devuelve null para un comando desconocido o de otro remitente', async () => {
      const repo = new InMemoryChatMessageRepository()
      const commandId = uuid(5)
      await repo.append(draft({ commandId }))

      await expect(repo.findByCommand('ana', uuid(6))).resolves.toBeNull()
      await expect(repo.findByCommand('beto', commandId)).resolves.toBeNull()
    })
  })

  describe('readHistory', () => {
    it('un canal sin mensajes: sin mensajes, upTo 0, sin truncar', async () => {
      const repo = new InMemoryChatMessageRepository()

      await expect(
        repo.readHistory(LOBBY_CHANNEL, { afterSeq: null, limit: 50, now: NOW }),
      ).resolves.toEqual({ messages: [], upTo: 0, truncated: false })
    })

    it('devuelve los mensajes en orden ascendente de seq', async () => {
      const repo = new InMemoryChatMessageRepository()
      await fill(repo, 5)

      const page = await repo.readHistory(LOBBY_CHANNEL, { afterSeq: null, limit: 50, now: NOW })

      expect(page.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
      expect(page.upTo).toBe(5)
    })

    describe('afterSeq (reconexion con lastSeq)', () => {
      it('devuelve solo lo posterior: afterSeq = 3 excluye el 3', async () => {
        const repo = new InMemoryChatMessageRepository()
        await fill(repo, 5)

        const page = await repo.readHistory(LOBBY_CHANNEL, { afterSeq: 3, limit: 50, now: NOW })

        expect(page.messages.map((m) => m.seq)).toEqual([4, 5])
      })

      it('afterSeq = ultimo seq: al dia, sin mensajes y upTo intacto', async () => {
        const repo = new InMemoryChatMessageRepository()
        await fill(repo, 5)

        const page = await repo.readHistory(LOBBY_CHANNEL, { afterSeq: 5, limit: 50, now: NOW })

        expect(page).toEqual({ messages: [], upTo: 5, truncated: false })
      })

      it('afterSeq = 0 equivale a pedir desde el principio', async () => {
        const repo = new InMemoryChatMessageRepository()
        await fill(repo, 3)

        const page = await repo.readHistory(LOBBY_CHANNEL, { afterSeq: 0, limit: 50, now: NOW })

        expect(page.messages.map((m) => m.seq)).toEqual([1, 2, 3])
      })

      it('un afterSeq MAYOR que el ultimo seq no inventa mensajes', async () => {
        const repo = new InMemoryChatMessageRepository()
        await fill(repo, 3)

        const page = await repo.readHistory(LOBBY_CHANNEL, { afterSeq: 99, limit: 50, now: NOW })

        expect(page.messages).toEqual([])
        expect(page.upTo).toBe(3)
      })
    })

    describe('limite y truncado', () => {
      it('frontera: exactamente `limit` mensajes NO es truncado', async () => {
        const repo = new InMemoryChatMessageRepository()
        await fill(repo, 5)

        const page = await repo.readHistory(LOBBY_CHANNEL, { afterSeq: null, limit: 5, now: NOW })

        expect(page.messages).toHaveLength(5)
        expect(page.truncated).toBe(false)
      })

      it('frontera: `limit + 1` mensajes SI es truncado y se conservan los MAS RECIENTES', async () => {
        const repo = new InMemoryChatMessageRepository()
        await fill(repo, 6)

        const page = await repo.readHistory(LOBBY_CHANNEL, { afterSeq: null, limit: 5, now: NOW })

        expect(page.messages.map((m) => m.seq)).toEqual([2, 3, 4, 5, 6])
        expect(page.truncated).toBe(true)
      })

      it('un salto mayor que el limite se declara truncado en vez de callarlo', async () => {
        const repo = new InMemoryChatMessageRepository()
        await fill(repo, 20)

        const page = await repo.readHistory(LOBBY_CHANNEL, { afterSeq: 2, limit: 5, now: NOW })

        expect(page.messages.map((m) => m.seq)).toEqual([16, 17, 18, 19, 20])
        expect(page.truncated).toBe(true)
        expect(page.upTo).toBe(20)
      })
    })

    describe('retencion', () => {
      it('un mensaje con expiresAt <= now no se devuelve (frontera exacta)', async () => {
        const repo = new InMemoryChatMessageRepository()
        await repo.append(draft({ expiresAt: new Date(NOW.getTime() + 1_000) }))

        const beforeExpiry = await repo.readHistory(LOBBY_CHANNEL, {
          afterSeq: null,
          limit: 50,
          now: new Date(NOW.getTime() + 999),
        })
        const atExpiry = await repo.readHistory(LOBBY_CHANNEL, {
          afterSeq: null,
          limit: 50,
          now: new Date(NOW.getTime() + 1_000),
        })

        expect(beforeExpiry.messages).toHaveLength(1)
        expect(atExpiry.messages).toHaveLength(0)
      })

      it('upTo NO retrocede cuando todos los mensajes expiran: la numeracion no se reinicia', async () => {
        const repo = new InMemoryChatMessageRepository()
        await fill(repo, 3)

        const page = await repo.readHistory(LOBBY_CHANNEL, {
          afterSeq: null,
          limit: 50,
          now: new Date(NOW.getTime() + 2 * HOUR),
        })
        const next = await repo.append(draft())

        expect(page.messages).toEqual([])
        expect(page.upTo).toBe(3)
        expect(next.message.seq).toBe(4)
      })

      it('solo se ocultan los expirados: los vigentes de un mismo canal siguen', async () => {
        const repo = new InMemoryChatMessageRepository()
        await repo.append(draft({ expiresAt: new Date(NOW.getTime() + 1_000) }))
        await repo.append(draft({ expiresAt: new Date(NOW.getTime() + HOUR) }))

        const page = await repo.readHistory(LOBBY_CHANNEL, {
          afterSeq: null,
          limit: 50,
          now: new Date(NOW.getTime() + 5_000),
        })

        expect(page.messages.map((m) => m.seq)).toEqual([2])
      })
    })

    describe('aislamiento entre canales', () => {
      it('el historial de una sala no contiene mensajes del lobby ni de otra sala', async () => {
        const repo = new InMemoryChatMessageRepository()
        const roomA = roomChatChannel(uuid(1))
        const roomB = roomChatChannel(uuid(2))

        await repo.append(draft({ channel: LOBBY_CHANNEL, text: 'lobby' }))
        await repo.append(draft({ channel: roomA, text: 'sala A' }))
        await repo.append(draft({ channel: roomB, text: 'sala B' }))

        const a = await repo.readHistory(roomA, { afterSeq: null, limit: 50, now: NOW })
        const b = await repo.readHistory(roomB, { afterSeq: null, limit: 50, now: NOW })
        const lobby = await repo.readHistory(LOBBY_CHANNEL, { afterSeq: null, limit: 50, now: NOW })

        expect(a.messages.map((m) => m.text)).toEqual(['sala A'])
        expect(b.messages.map((m) => m.text)).toEqual(['sala B'])
        expect(lobby.messages.map((m) => m.text)).toEqual(['lobby'])
      })
    })
  })
})
