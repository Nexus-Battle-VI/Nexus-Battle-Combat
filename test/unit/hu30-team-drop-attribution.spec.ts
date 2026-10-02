import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { InMemoryBattleDropWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleDropWorkflowRepository'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { IntervalBattleDropScheduler } from '../../src/adapters/outbound/system/IntervalBattleDropScheduler'
import type { BattleHeroCommitmentPort } from '../../src/application/ports/BattleHeroCommitmentPort'
import { battleDropWorkflowId } from '../../src/application/ports/BattleDropWorkflowRepositoryPort'
import { PersistVersusDropDecision } from '../../src/application/services/PersistVersusDropDecision'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { BattleRoomStatus } from '../../src/domain/value-objects/BattleRoomStatus'
import { NOW, ROOM_ID, clock, scriptedSequence, silentLogger } from '../fixtures/battle'
import { battleWithCombat, indexForEffect, indexForFace } from '../fixtures/basic-attack'
import { recordingBattleDropInventory } from '../fixtures/battle-drop-inventory'

/**
 * HU-30 (Task HU-30.2): el resultado final del EQUIPO no reasigna derechos de
 * drop, y un mismo jugador puede acumular varios drops (secciones 5/6/29 del
 * encargo). Real: `ExecuteBasicAttack`, `PersistVersusDropDecision`,
 * `ResolveVersusDrop` e `IntervalBattleDropScheduler` sin doblar. SUSTITUIDO
 * (declarado): `BattleDropInventoryPort` -el mismo doble que ya usan
 * `interval-battle-drop-scheduler.spec.ts`/los specs de integracion HTTP de
 * este repo-, porque lo que esta prueba verifica es la ATRIBUCION del
 * derecho dentro de Combat, no el cliente HTTP real hacia Player-Inventory
 * (eso ya lo prueba `test/e2e/hu-30`).
 */
describe('HU-30: la atribucion de drop en equipos no depende del resultado final', () => {
  it('2v2: A1 derrota a B1 y muere despues; B2 derrota a A1 y a A2 (dos derechos); B gana la partida', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime())

    const rooms = new InMemoryBattleRoomRepository()
    // a1, a2, b1 a 1 de vida (caen con cualquier golpe); b2 conserva su vida
    // base: es quien remata a los dos y gana la partida para el equipo B.
    // Orden de turnos real (ronda: A#0, B#0, A#1, B#1): a1, b1, a2, b2.
    await rooms.save(
      battleWithCombat({
        teamSizes: [2, 2],
        health: { 'A#0': 1, 'A#1': 1, 'B#0': 1 },
      }),
      0,
    )

    const lethalHit = [
      indexForFace(5, 6),
      indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
      indexForFace(4, 6),
      1,
      1,
    ]
    const nonLethalHit = [
      indexForFace(5, 6),
      indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
      indexForFace(4, 6),
    ]

    const sequence = scriptedSequence([
      ...lethalHit, // turno 1 (a1): a1 derrota a b1 -- derecho b1 -> a1.
      ...nonLethalHit, // turno 3 (a2, b1 saltado por caido): golpea a b2 sin derribarlo.
      ...lethalHit, // turno 4 (b2): b2 derrota a a1 -- derecho a1 -> b2 (primero de b2).
      ...nonLethalHit, // turno 7 (a2, a1 saltado por caido): golpea a b2 de nuevo, sin derribarlo.
      ...lethalHit, // turno 8 (b2): b2 derrota a a2 -- derecho a2 -> b2 (segundo de b2); equipo A eliminado.
    ])

    const inventory = recordingBattleDropInventory()
    inventory.equipmentByKey.set(`${ROOM_ID}::b1`, [
      {
        productInstanceId: 'unit-b1',
        productId: 'product-b1',
        itemId: 'item-b1',
        dropChanceBasisPoints: 10_000,
      },
    ])
    inventory.equipmentByKey.set(`${ROOM_ID}::a1`, [
      {
        productInstanceId: 'unit-a1',
        productId: 'product-a1',
        itemId: 'item-a1',
        dropChanceBasisPoints: 10_000,
      },
    ])
    inventory.equipmentByKey.set(`${ROOM_ID}::a2`, [
      {
        productInstanceId: 'unit-a2',
        productId: 'product-a2',
        itemId: 'item-a2',
        dropChanceBasisPoints: 10_000,
      },
    ])

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

    const a1KillsB1 = await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'a1',
      commandId: 'a1-kills-b1',
      target: { teamLabel: 'B', seat: 0 },
    })
    expect(a1KillsB1.finished).toBeNull()

    // b1 cayo: el turno salta de B#0 a A#1 (a2).
    const a2HitsB2 = await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'a2',
      commandId: 'a2-golpea-b2-primero',
      target: { teamLabel: 'B', seat: 1 },
    })
    expect(a2HitsB2.finished).toBeNull()

    const b2KillsA1 = await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'b2',
      commandId: 'b2-kills-a1',
      target: { teamLabel: 'A', seat: 0 },
    })
    expect(b2KillsA1.finished).toBeNull()

    // a1 cayo: el turno salta de A#0 a A#1 (a2) en la ronda siguiente.
    const a2HitsB2Again = await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'a2',
      commandId: 'a2-golpea-b2-segundo',
      target: { teamLabel: 'B', seat: 1 },
    })
    expect(a2HitsB2Again.finished).toBeNull()

    const b2KillsA2 = await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'b2',
      commandId: 'b2-kills-a2',
      target: { teamLabel: 'A', seat: 1 },
    })

    // Equipo A completo derrotado: la partida termina y B es el equipo ganador.
    expect(b2KillsA2.finished?.status).toBe(BattleRoomStatus.Finished)
    expect(b2KillsA2.finished?.result?.winnerTeamLabel).toBe('B')

    await scheduler.tick()

    const seq1 = battleDropWorkflowId(ROOM_ID, a1KillsB1.event.seq)
    const seq2 = battleDropWorkflowId(ROOM_ID, b2KillsA1.event.seq)
    const seq3 = battleDropWorkflowId(ROOM_ID, b2KillsA2.event.seq)

    const workflowB1ToA1 = await workflows.findById(seq1)
    const workflowA1ToB2 = await workflows.findById(seq2)
    const workflowA2ToB2 = await workflows.findById(seq3)

    // El derecho de A1 sobre B1 se liquida igual, AUNQUE A1 termine en el
    // equipo perdedor (y muerto): el resultado final del equipo NO lo anula.
    expect(workflowB1ToA1).toMatchObject({
      killerPlayerId: 'a1',
      defeatedPlayerId: 'b1',
      state: 'CREDITED',
      receipt: { sourcePlayerId: 'b1', targetPlayerId: 'a1', productInstanceId: 'unit-b1' },
    })

    // B2 acumula DOS derechos independientes en la misma partida, uno por
    // cada derrota que produjo -- nunca "maximo un drop por partida".
    expect(workflowA1ToB2).toMatchObject({
      killerPlayerId: 'b2',
      defeatedPlayerId: 'a1',
      state: 'CREDITED',
      receipt: { sourcePlayerId: 'a1', targetPlayerId: 'b2', productInstanceId: 'unit-a1' },
    })
    expect(workflowA2ToB2).toMatchObject({
      killerPlayerId: 'b2',
      defeatedPlayerId: 'a2',
      state: 'CREDITED',
      receipt: { sourcePlayerId: 'a2', targetPlayerId: 'b2', productInstanceId: 'unit-a2' },
    })

    expect(inventory.transfers).toHaveLength(3)
    expect(inventory.closedBattles).toEqual([ROOM_ID])

    // Se libera el compromiso HU-29 de los CUATRO humanos, una sola vez cada uno.
    expect(release).toHaveBeenCalledTimes(4)
    const releasedPlayerIds = release.mock.calls.map((call: unknown[]) => call[1]).sort()
    expect(releasedPlayerIds).toEqual(['a1', 'a2', 'b1', 'b2'])
  })
})
