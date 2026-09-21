import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { findHumanParticipant, isRoomChatOpen } from '../../src/domain/policies/ChatAccessPolicy'
import { BattleRoomStatus } from '../../src/domain/value-objects/BattleRoomStatus'
import { uuid } from '../fixtures/chat-harness'

/**
 * Quien accede al chat de una sala (HU-13, RF-13): solo participantes HUMANOS y
 * solo mientras la sala esta activa.
 */
describe('ChatAccessPolicy', () => {
  describe('estado de la sala', () => {
    it.each([
      [BattleRoomStatus.WaitingForPlayers, true],
      [BattleRoomStatus.Preparing, true],
      [BattleRoomStatus.InBattle, true],
      [BattleRoomStatus.Cancelled, false],
    ])('%s -> chat abierto: %s', (status, open) => {
      expect(isRoomChatOpen(status)).toBe(open)
    })

    it('TODO estado existente esta clasificado explicitamente (un estado nuevo obliga a decidir)', () => {
      for (const status of Object.values(BattleRoomStatus)) {
        expect(typeof isRoomChatOpen(status)).toBe('boolean')
      }
    })
  })

  describe('participante humano', () => {
    const at = new Date('2026-09-20T12:00:00.000Z')

    const roomWith = (): BattleRoom => {
      const room = BattleRoom.create(
        uuid(1),
        'creador',
        {
          mode: 'PVP',
          teamConfigs: [{ capacity: 2 }, { capacity: 2 }],
          reward: { amount: 0 },
        },
        at,
      )
      const withAna = room.join('ana', 'A', at, 'Ana')

      return withAna.join('beto', 'B', at, 'Beto')
    }

    it('encuentra a un jugador del equipo A', () => {
      expect(findHumanParticipant(roomWith(), 'ana')?.displayName).toBe('Ana')
    })

    it('encuentra a un jugador del equipo B', () => {
      expect(findHumanParticipant(roomWith(), 'beto')?.displayName).toBe('Beto')
    })

    it('un jugador que no esta en la sala no es participante', () => {
      expect(findHumanParticipant(roomWith(), 'ajeno')).toBeNull()
    })

    it('el creador que no se unio NO es participante', () => {
      expect(findHumanParticipant(roomWith(), 'creador')).toBeNull()
    })

    it('un participante IA nunca coincide, ni siquiera con un playerId vacio', () => {
      const room = BattleRoom.create(
        uuid(2),
        'creador',
        {
          mode: 'PVE',
          teamConfigs: [
            { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: 'ana' }] },
            { capacity: 1, initialParticipants: [{ kind: 'AI' }] },
          ],
          reward: { amount: 0 },
        },
        at,
      )

      expect(findHumanParticipant(room, '')).toBeNull()
      expect(findHumanParticipant(room, 'ana')).not.toBeNull()
    })
  })
})
