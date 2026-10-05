import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import type { BattleDropInventoryPort } from '../../src/application/ports/BattleDropInventoryPort'
import { PersistVersusDropDecision } from '../../src/application/services/PersistVersusDropDecision'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import type { BasicAttackResolvedPayload } from '../../src/domain/entities/BattleEvent'
import { Combatant } from '../../src/domain/entities/Combatant'
import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { NOW, ROOM_ID, clock, preparingRoom, scriptedSequence } from '../fixtures/battle'
import {
  battleWithCombat,
  combatProfileFixture,
  indexForEffect,
  indexForFace,
} from '../fixtures/basic-attack'

/**
 * `battleWithCombat` siempre deja el perfil del participante `AI` en `null`
 * (lo resuelve de verdad `BotParticipantFactory`, HU-93.1): sin perfil, un
 * combatiente no puede cambiar de Vida (`Combatant.withHealth`). Para forzar
 * aqui un golpe letal sobre la IA en 1 solo intercambio, se construye la sala
 * con las mismas piezas publicas del dominio, pero con un perfil REAL de
 * Vida minima para el participante AI.
 */
const pveRoomWithLowHealthAi = (): BattleRoom => {
  const room = preparingRoom({ aiInTeamB: 1 })
  const roster = room.roster()
  const order = roster.flatMap((team) =>
    team.members.map((member) => ({
      ...member,
      heroSubtype: member.playerId === null ? null : 'GUERRERO_ARMAS',
    })),
  )
  const combatants = order.map((entry) =>
    Combatant.start(
      entry,
      entry.playerId === null ? combatProfileFixture({ maxHealth: 1 }) : combatProfileFixture(),
    ),
  )

  return room.startBattle(order, NOW, combatants)
}

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

  it('HU-93.3: en PVE (Humano vs IA) no sortea drop ni consulta inventory.find al matar a la IA', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(pveRoomWithLowHealthAi(), 0)
    // Solo los 3 sorteos del ataque en si (dado de ataque, efecto, dado de dano):
    // sin los 2 adicionales de resolveVersusDrop que si aparecen en el caso PVP.
    const sequence = scriptedSequence([
      indexForFace(5, 6),
      indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
      indexForFace(4, 6),
    ])
    const find = jest.fn()
    const inventory: BattleDropInventoryPort = {
      capture: jest.fn(),
      find,
      transfer: jest.fn(),
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

    const result = await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'a1',
      commandId: 'hu93-3-pve-lethal-1',
      target: { teamLabel: 'B', seat: 0 },
    })

    expect(result.finished?.status).toBe('FINISHED')
    const payload = result.event.payload as BasicAttackResolvedPayload
    expect(payload.versusDrop).toBeUndefined()
    expect(find).not.toHaveBeenCalled()
    expect(sequence.consumed()).toBe(3)
  })
})
