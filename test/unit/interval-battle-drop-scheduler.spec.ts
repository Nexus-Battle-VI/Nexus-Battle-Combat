import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { InMemoryBattleDropWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleDropWorkflowRepository'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { IntervalBattleDropScheduler } from '../../src/adapters/outbound/system/IntervalBattleDropScheduler'
import type { BattleHeroCommitmentPort } from '../../src/application/ports/BattleHeroCommitmentPort'
import type { BattleDropInventoryPort } from '../../src/application/ports/BattleDropInventoryPort'
import { battleDropWorkflowId } from '../../src/application/ports/BattleDropWorkflowRepositoryPort'
import { PersistVersusDropDecision } from '../../src/application/services/PersistVersusDropDecision'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import {
  NOW,
  ROOM_ID,
  clock,
  finishedRoom,
  scriptedSequence,
  silentLogger,
} from '../fixtures/battle'
import { battleWithCombat, indexForEffect, indexForFace } from '../fixtures/basic-attack'

describe('HU-30: conciliación del drop diferido', () => {
  afterEach(() => jest.restoreAllMocks())

  it('transfiere solo tras FINISHED; repetición no duplica ni retiene unidades', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime())
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(battleWithCombat({ health: { 'B#0': 1 } }), 0)
    const sequence = scriptedSequence([
      indexForFace(5, 6),
      indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
      indexForFace(4, 6),
      1,
      1,
    ])
    const transfer = jest.fn().mockResolvedValue({
      operationId: '44444444-4444-4444-8444-444444444444',
      battleId: ROOM_ID,
      defeatEventSeq: 2,
      sourcePlayerId: 'b1',
      targetPlayerId: 'a1',
      productInstanceId: 'unit-1',
      productId: 'product-1',
      itemId: 'item-1',
      creditedAt: '2026-10-01T00:00:00.000Z',
    })
    const closeBattle = jest.fn().mockResolvedValue(undefined)
    const inventory: BattleDropInventoryPort = {
      capture: jest.fn(),
      find: jest.fn().mockResolvedValue({
        battleId: ROOM_ID,
        playerId: 'b1',
        heroId: 'hero-b1',
        loadoutVersion: 3,
        equipment: [
          {
            productInstanceId: 'unit-1',
            productId: 'product-1',
            itemId: 'item-1',
            dropChanceBasisPoints: 10000,
          },
        ],
      }),
      transfer,
      closeBattle,
    }
    const release = jest.fn().mockResolvedValue(undefined)
    const commitments: BattleHeroCommitmentPort = {
      commit: jest.fn(),
      release,
    }
    const workflows = new InMemoryBattleDropWorkflowRepository()
    const scheduler = new IntervalBattleDropScheduler(
      rooms,
      workflows,
      inventory,
      commitments,
      { notify: jest.fn().mockResolvedValue(undefined) },
      silentLogger,
    )
    await scheduler.tick()
    expect(transfer).not.toHaveBeenCalled()

    const attack = new ExecuteBasicAttack(
      rooms,
      clock,
      sequence,
      new ChannelLock(),
      null,
      undefined,
      new PersistVersusDropDecision(inventory, sequence),
    )
    await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'a1',
      commandId: 'lethal-1',
      target: { teamLabel: 'B', seat: 0 },
    })
    expect(transfer).not.toHaveBeenCalled()

    await scheduler.tick()
    expect(await workflows.findById(battleDropWorkflowId(ROOM_ID, 2))).toMatchObject({
      state: 'CREDITED',
      receipt: { productInstanceId: 'unit-1' },
    })
    expect(transfer).toHaveBeenCalledTimes(1)
    expect(closeBattle).toHaveBeenCalledWith(ROOM_ID)
    expect(release).toHaveBeenCalledTimes(2)

    await scheduler.tick()
    expect(transfer).toHaveBeenCalledTimes(1)
    expect(closeBattle).toHaveBeenCalledTimes(1)
  })

  it('HU-93.3: una sala PVE FINISHED nunca llama a closeBattle ni libera compromisos por este camino', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(finishedRoom({ aiInTeamB: 1, winnerTeamLabel: 'A' }), 0)
    const closeBattle = jest.fn().mockResolvedValue(undefined)
    const inventory: BattleDropInventoryPort = {
      capture: jest.fn(),
      find: jest.fn(),
      transfer: jest.fn(),
      closeBattle,
    }
    const release = jest.fn().mockResolvedValue(undefined)
    const commitments: BattleHeroCommitmentPort = { commit: jest.fn(), release }
    const workflows = new InMemoryBattleDropWorkflowRepository()
    const scheduler = new IntervalBattleDropScheduler(
      rooms,
      workflows,
      inventory,
      commitments,
      { notify: jest.fn().mockResolvedValue(undefined) },
      silentLogger,
    )

    await scheduler.tick()

    // El unico origen de un drop diferido es `PersistVersusDropDecision`
    // (PVP exclusivo): una sala PVE jamas tuvo nada que conciliar, asi que
    // barrerla no debe producir ninguna llamada de cierre contra
    // Player-Inventory ni ninguna liberacion de compromiso por este camino
    // (`BattleFinalizer` ya libera los compromisos al finalizar).
    expect(closeBattle).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })
})
