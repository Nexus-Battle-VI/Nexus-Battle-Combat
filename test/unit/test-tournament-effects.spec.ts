import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { buildBattleFinishedNotification } from '../../src/application/services/BattleFinalizer'
import { PersistVersusDropDecision } from '../../src/application/services/PersistVersusDropDecision'
import { ReconcileRewardWorkflows } from '../../src/application/use-cases/ReconcileRewardWorkflows'
import { CreateRewardWorkflows } from '../../src/application/use-cases/CreateRewardWorkflows'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryRewardWorkflowRepository'
import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { battleWithCombat, indexForFace, indexForEffect } from '../fixtures/basic-attack'
import { clock, ROOM_ID, scriptedSequence, silentLogger } from '../fixtures/battle'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'
import { finalizationHarness } from '../fixtures/finalization'
import { tournamentHarness, tournamentRequest } from '../fixtures/tournament-cardinality'
import { TournamentRoomOperationReusedError } from '../../src/application/errors/TournamentRoomErrors'

const testRoom = (room: BattleRoom) =>
  BattleRoom.restore({
    ...room.toSnapshot(),
    tournament: {
      operationId: 'pilot-E1',
      tournamentId: 'pilot',
      encounterId: 'E1',
      requestHash: 'a'.repeat(64),
      contractVersion: 3,
      mode: 'SOLO',
      teamSize: 1,
      isTest: true,
    },
  })

describe('Batallas de prueba: resultado jugable sin efectos sobre la cuenta', () => {
  it('crea el modo de prueba mediante la ruta interna; cambiarlo reutilizando la operación es conflicto', async () => {
    const harness = tournamentHarness(new InMemoryBattleRoomRepository())
    const request = { ...tournamentRequest('SOLO'), isTest: true }
    const room = await harness.create(request)
    expect(room.tournament).toMatchObject({ isTest: true, mode: 'SOLO', teamSize: 1 })
    expect((await harness.rooms.findById(room.id))?.tournament?.isTest).toBe(true)
    await expect(harness.create({ ...request, isTest: false })).rejects.toBeInstanceOf(
      TournamentRoomOperationReusedError,
    )
  })

  it('una eliminación guarda ganador y eventos sin sortear ni transferir objetos', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(testRoom(battleWithCombat({ health: { 'B#0': 1 } })), 0)
    const sequence = scriptedSequence([
      indexForFace(5, 6),
      indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
      indexForFace(4, 6),
    ])
    const inventory = {
      capture: jest.fn(),
      find: jest.fn(),
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
    const response = await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'a1',
      commandId: 'pilot-kill',
      target: { teamLabel: 'B', seat: 0 },
    })
    expect(response.finished?.result).toMatchObject({ reason: 'ELIMINATION', winnerTeamLabel: 'A' })
    expect(response.event.payload).not.toHaveProperty('versusDrop')
    expect(inventory.find).not.toHaveBeenCalled()
    expect(inventory.transfer).not.toHaveBeenCalled()
    expect(sequence.consumed()).toBe(3)
    expect((await rooms.findById(ROOM_ID))?.events.some((e) => e.type === 'battleFinished')).toBe(
      true,
    )
  })

  it('no publica derechos de créditos, cofre o experiencia; libera los héroes al finalizar y al reiniciar', async () => {
    const finished = testRoom(
      battleWithCombat({ health: { 'B#0': 0 } }).finish(
        { reason: 'ELIMINATION', winnerTeamLabel: 'A' },
        new Date('2026-09-21T10:05:00Z'),
      ),
    )
    expect(buildBattleFinishedNotification(finished)).toBeNull()
    const h = finalizationHarness()
    h.finalizer.afterFinished(finished)
    await Promise.resolve()
    expect(h.notifications).toEqual([])
    expect(h.commitments.releases).toHaveLength(2)
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(finished, 0)
    const workflows = new InMemoryRewardWorkflowRepository()
    const commitments = recordingBattleCommitments()
    const reconcile = new ReconcileRewardWorkflows(
      rooms,
      new CreateRewardWorkflows(workflows),
      commitments,
      silentLogger,
    )
    await reconcile.execute(new Date('2026-09-21T00:00:00Z'))
    expect(commitments.releases).toHaveLength(2)
    expect(await workflows.findByBattleAndPlayer(finished.id, 'a1')).toBeNull()
    expect(await workflows.findByBattleAndPlayer(finished.id, 'b1')).toBeNull()
  })
})
