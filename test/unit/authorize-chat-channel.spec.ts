import { RoomNotFoundError } from '../../src/application/errors/ApplicationError'
import {
  ChatRoomNotActiveError,
  NotARoomParticipantError,
} from '../../src/application/errors/ChatApplicationErrors'
import { LOBBY_CHANNEL, roomChatChannel } from '../../src/domain/value-objects/ChatChannel'
import {
  buildChatHarness,
  cancelRoom,
  createRoom,
  joinRoom,
  leaveRoom,
  uuid,
} from '../fixtures/chat-harness'

/**
 * Autorizacion por canal (HU-13, RF-13): quien puede leer y escribir donde.
 * Se consulta el estado PERSISTIDO de la sala en cada llamada.
 */
describe('AuthorizeChatChannel', () => {
  const ROOM = uuid(1)

  describe('lobby', () => {
    it('cualquier identidad verificada accede', async () => {
      const { authorize } = buildChatHarness()

      await expect(authorize.execute('ana', LOBBY_CHANNEL)).resolves.toEqual({
        participantDisplayName: null,
      })
      await expect(authorize.execute('otra-persona', LOBBY_CHANNEL)).resolves.toBeDefined()
    })

    it('no consulta ninguna sala', async () => {
      const harness = buildChatHarness()
      const findById = jest.spyOn(harness.rooms, 'findById')

      await harness.authorize.execute('ana', LOBBY_CHANNEL)

      expect(findById).not.toHaveBeenCalled()
    })
  })

  describe('sala', () => {
    it('un participante accede y recibe su nombre de la sala', async () => {
      const { authorize, rooms } = buildChatHarness()
      await createRoom(rooms, ROOM)
      await joinRoom(rooms, ROOM, 'ana', 'Ana')

      await expect(authorize.execute('ana', roomChatChannel(ROOM))).resolves.toEqual({
        participantDisplayName: 'Ana',
      })
    })

    it('un participante sin snapshot de nombre accede con nombre nulo', async () => {
      const { authorize, rooms } = buildChatHarness()
      await createRoom(rooms, ROOM)
      await joinRoom(rooms, ROOM, 'ana', null)

      await expect(authorize.execute('ana', roomChatChannel(ROOM))).resolves.toEqual({
        participantDisplayName: null,
      })
    })

    it('un jugador que no esta en la sala es rechazado', async () => {
      const { authorize, rooms } = buildChatHarness()
      await createRoom(rooms, ROOM)
      await joinRoom(rooms, ROOM, 'ana', 'Ana')

      await expect(authorize.execute('intruso', roomChatChannel(ROOM))).rejects.toBeInstanceOf(
        NotARoomParticipantError,
      )
    })

    it('el creador que no se unio a la sala tampoco accede', async () => {
      const { authorize, rooms } = buildChatHarness()
      await createRoom(rooms, ROOM, 'creador')

      await expect(authorize.execute('creador', roomChatChannel(ROOM))).rejects.toBeInstanceOf(
        NotARoomParticipantError,
      )
    })

    it('una sala inexistente se rechaza como inexistente', async () => {
      const { authorize } = buildChatHarness()

      await expect(authorize.execute('ana', roomChatChannel(uuid(99)))).rejects.toBeInstanceOf(
        RoomNotFoundError,
      )
    })

    it('una sala cancelada tiene el chat cerrado, incluso para quien fue participante', async () => {
      const { authorize, rooms } = buildChatHarness()
      await createRoom(rooms, ROOM, 'creador')
      await joinRoom(rooms, ROOM, 'ana', 'Ana')
      await cancelRoom(rooms, ROOM, 'creador')

      await expect(authorize.execute('ana', roomChatChannel(ROOM))).rejects.toBeInstanceOf(
        ChatRoomNotActiveError,
      )
    })

    it('el estado se comprueba ANTES que la pertenencia (como BattleRoom.join)', async () => {
      const { authorize, rooms } = buildChatHarness()
      await createRoom(rooms, ROOM, 'creador')
      await cancelRoom(rooms, ROOM, 'creador')

      await expect(authorize.execute('intruso', roomChatChannel(ROOM))).rejects.toBeInstanceOf(
        ChatRoomNotActiveError,
      )
    })

    it('una sala llena (PREPARING) mantiene el chat abierto', async () => {
      const { authorize, rooms } = buildChatHarness()
      await createRoom(rooms, ROOM)

      for (const player of ['a', 'b', 'c', 'd']) {
        await joinRoom(rooms, ROOM, player, player.toUpperCase())
      }

      const room = await rooms.findById(ROOM)

      expect(room?.status).toBe('PREPARING')
      await expect(authorize.execute('a', roomChatChannel(ROOM))).resolves.toBeDefined()
    })

    it('quien abandona la sala pierde el acceso en el acto', async () => {
      const { authorize, rooms } = buildChatHarness()
      await createRoom(rooms, ROOM)
      await joinRoom(rooms, ROOM, 'ana', 'Ana')
      await joinRoom(rooms, ROOM, 'beto', 'Beto')

      await expect(authorize.execute('ana', roomChatChannel(ROOM))).resolves.toBeDefined()

      await leaveRoom(rooms, ROOM, 'ana')

      await expect(authorize.execute('ana', roomChatChannel(ROOM))).rejects.toBeInstanceOf(
        NotARoomParticipantError,
      )
      await expect(authorize.execute('beto', roomChatChannel(ROOM))).resolves.toBeDefined()
    })
  })
})
