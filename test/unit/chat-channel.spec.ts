import { DomainError } from '../../src/domain/errors/DomainError'
import { InvalidChatCommandError } from '../../src/domain/errors/ChatErrors'
import {
  ChatChannelKind,
  LOBBY_CHANNEL,
  chatChannelFromKey,
  chatChannelKey,
  parseChatChannel,
  roomChatChannel,
} from '../../src/domain/value-objects/ChatChannel'
import { uuid } from '../fixtures/chat-harness'

/**
 * Contexto del chat (HU-13, RF-13). La clave del canal es la frontera de
 * aislamiento: dos claves distintas nunca comparten mensajes.
 */
describe('ChatChannel', () => {
  describe('clave del canal', () => {
    it('el lobby tiene la clave `lobby`', () => {
      expect(chatChannelKey(LOBBY_CHANNEL)).toBe('lobby')
    })

    it('una sala tiene la clave `room:<uuid>`', () => {
      expect(chatChannelKey(roomChatChannel(uuid(7)))).toBe(`room:${uuid(7)}`)
    })

    it('salas distintas tienen claves distintas y el lobby no coincide con ninguna', () => {
      const keys = new Set([
        chatChannelKey(LOBBY_CHANNEL),
        chatChannelKey(roomChatChannel(uuid(1))),
        chatChannelKey(roomChatChannel(uuid(2))),
      ])

      expect(keys.size).toBe(3)
    })

    it('el UUID se normaliza a minusculas: dos grafias no son dos canales', () => {
      const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

      expect(chatChannelKey(roomChatChannel(lower.toUpperCase()))).toBe(`room:${lower}`)
      expect(chatChannelKey(roomChatChannel(lower.toUpperCase()))).toBe(
        chatChannelKey(roomChatChannel(lower)),
      )
    })

    it('un roomId que no es UUID v4 no forma un canal', () => {
      expect(() => roomChatChannel('sala-1')).toThrow(DomainError)
      expect(() => roomChatChannel('11111111-1111-1111-1111-111111111111')).toThrow(DomainError)
    })
  })

  describe('restaurar desde la clave', () => {
    it('es la inversa de chatChannelKey', () => {
      expect(chatChannelFromKey('lobby')).toEqual(LOBBY_CHANNEL)
      expect(chatChannelFromKey(`room:${uuid(3)}`)).toEqual({
        kind: ChatChannelKind.Room,
        roomId: uuid(3),
      })
    })

    it.each(['', 'sala', 'room:', 'room:no-es-uuid', 'lobby:2', 'LOBBY'])(
      'una clave corrupta (%p) es un DomainError',
      (key) => {
        expect(() => chatChannelFromKey(key)).toThrow(DomainError)
      },
    )
  })

  describe('canal declarado en un comando', () => {
    it('lobby', () => {
      expect(parseChatChannel({ channel: 'lobby' })).toEqual(LOBBY_CHANNEL)
    })

    it('sala con roomId valido', () => {
      expect(parseChatChannel({ channel: 'room', roomId: uuid(5) })).toEqual({
        kind: ChatChannelKind.Room,
        roomId: uuid(5),
      })
    })

    it('un roomId junto a lobby es un comando mal formado, no se ignora', () => {
      expect(() => parseChatChannel({ channel: 'lobby', roomId: uuid(5) })).toThrow(
        InvalidChatCommandError,
      )
    })

    it.each([
      ['room sin roomId', { channel: 'room' }],
      ['room con roomId vacio', { channel: 'room', roomId: '' }],
      ['room con roomId no UUID', { channel: 'room', roomId: 'abc' }],
      ['room con roomId numerico', { channel: 'room', roomId: 5 }],
      ['canal desconocido', { channel: 'global' }],
      ['canal en mayusculas', { channel: 'LOBBY' }],
      ['sin canal', {}],
      ['canal numerico', { channel: 1 }],
      ['canal nulo', { channel: null }],
    ])('%s', (_label, input) => {
      expect(() => parseChatChannel(input)).toThrow(InvalidChatCommandError)
    })
  })
})
