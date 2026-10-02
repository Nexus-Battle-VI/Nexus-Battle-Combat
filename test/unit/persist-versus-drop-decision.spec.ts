import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import type { BattleDropInventoryPort } from '../../src/application/ports/BattleDropInventoryPort'
import { PersistVersusDropDecision } from '../../src/application/services/PersistVersusDropDecision'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import type { BasicAttackResolvedPayload } from '../../src/domain/entities/BattleEvent'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { NOW, ROOM_ID, clock, scriptedSequence } from '../fixtures/battle'
import { battleWithCombat, indexForEffect, indexForFace } from '../fixtures/basic-attack'

describe('HU-30: decisión guardada en el evento letal', () => {
  it('persiste el drop pendiente con el evento; un replay no vuelve a sortear ni transfiere', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(battleWithCombat({ health: { 'B#0': 1 } }), 0)
    const sequence = scriptedSequence([
      indexForFace(5, 6),
      indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
      indexForFace(4, 6),
      1,
      1,
    ])
    const transfer = jest.fn()
    const inventory: BattleDropInventoryPort = {
      capture: jest.fn(),
      find: jest.fn().mockResolvedValue({
        battleId: ROOM_ID,
        playerId: 'b1',
        heroId: 'hero-b1',
        loadoutVersion: 3,
        equipment: [
          {
            productInstanceId: 'physical-piece-1',
            productId: 'product-1',
            itemId: 'item-1',
            dropChanceBasisPoints: 10000,
          },
        ],
      }),
      transfer,
      closeBattle: jest.fn(),
    }
    const drop = new PersistVersusDropDecision(inventory, sequence)
    const attack = new ExecuteBasicAttack(
      rooms,
      clock,
      sequence,
      new ChannelLock(),
      null,
      undefined,
      drop,
    )
    const input = {
      roomId: ROOM_ID,
      requesterId: 'a1',
      commandId: 'hu30-lethal-1',
      target: { teamLabel: 'B', seat: 0 },
    }

    const first = await attack.execute(input)
    const persisted = await rooms.findById(ROOM_ID)
    const payload = first.event.payload as BasicAttackResolvedPayload
    expect(first.finished?.status).toBe('FINISHED')
    expect(payload.versusDrop).toMatchObject({
      killerPlayerId: 'a1',
      defeatedPlayerId: 'b1',
      resolution: { status: 'PENDING', selected: { productInstanceId: 'physical-piece-1' } },
    })
    expect((persisted?.events[1]?.payload as BasicAttackResolvedPayload).versusDrop).toEqual(
      payload.versusDrop,
    )
    expect(transfer).not.toHaveBeenCalled()
    expect(sequence.consumed()).toBe(5)

    const replay = await attack.execute(input)
    expect(replay.replayed).toBe(true)
    expect(sequence.consumed()).toBe(5)
    expect(transfer).not.toHaveBeenCalled()
    expect(first.event.occurredAt).toEqual(NOW)
  })
})
