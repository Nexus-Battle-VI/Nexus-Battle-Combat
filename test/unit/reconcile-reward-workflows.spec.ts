import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryRewardWorkflowRepository'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import { CreateRewardWorkflows } from '../../src/application/use-cases/CreateRewardWorkflows'
import { ReconcileRewardWorkflows } from '../../src/application/use-cases/ReconcileRewardWorkflows'
import { battleWithCombat } from '../fixtures/basic-attack'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'
import { silentLogger } from '../fixtures/battle'

const AT = new Date('2026-09-21T10:05:00.000Z')

const finishedRoom = () =>
  battleWithCombat({ health: { 'B#0': 0 } }).finish(
    { reason: 'ELIMINATION', winnerTeamLabel: 'A' },
    AT,
  )

/**
 * `RewardWorkflowResultPublisher.publish()` crea el `RewardWorkflow`
 * fire-and-forget DESPUES de que la sala ya quedo `FINISHED` -- si el
 * proceso muere justo en ese hueco, el workflow nunca llega a existir y el
 * barrido normal (que solo lee workflows YA creados) no tiene nada que
 * recuperar. `ReconcileRewardWorkflows` cierra exactamente ese hueco.
 */
describe('ReconcileRewardWorkflows (HU-22): cierra el hueco entre sala FINISHED y RewardWorkflow', () => {
  it('crea el RewardWorkflow que el publish() fire-and-forget nunca llego a crear', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const room = finishedRoom()
    await rooms.save(room, 0)

    const workflows = new InMemoryRewardWorkflowRepository()
    const createWorkflows = new CreateRewardWorkflows(workflows)
    const reconcile = new ReconcileRewardWorkflows(
      rooms,
      createWorkflows,
      recordingBattleCommitments(),
      silentLogger,
    )

    expect(await workflows.findByBattleAndPlayer(room.id, 'a1')).toBeNull()

    const roomsChecked = await reconcile.execute(new Date('2026-09-21T00:00:00.000Z'))

    expect(roomsChecked).toBe(1)
    const created = await workflows.findByBattleAndPlayer(room.id, 'a1')

    expect(created).not.toBeNull()
    expect(created?.state).toBe('PENDING_CREDIT')
    expect(await workflows.findByBattleAndPlayer(room.id, 'b1')).not.toBeNull()
  })

  it('es idempotente: reconciliar dos veces no duplica ni recrea el workflow', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const room = finishedRoom()
    await rooms.save(room, 0)

    const workflows = new InMemoryRewardWorkflowRepository()
    const createWorkflows = new CreateRewardWorkflows(workflows)
    const reconcile = new ReconcileRewardWorkflows(
      rooms,
      createWorkflows,
      recordingBattleCommitments(),
      silentLogger,
    )
    const since = new Date('2026-09-21T00:00:00.000Z')

    await reconcile.execute(since)
    const first = await workflows.findByBattleAndPlayer(room.id, 'a1')

    await reconcile.execute(since)
    const second = await workflows.findByBattleAndPlayer(room.id, 'a1')

    expect(second).toEqual(first)
  })

  it('una sala FINISHED antes de la ventana no se reconcilia', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const room = finishedRoom()
    await rooms.save(room, 0)

    const workflows = new InMemoryRewardWorkflowRepository()
    const createWorkflows = new CreateRewardWorkflows(workflows)
    const reconcile = new ReconcileRewardWorkflows(
      rooms,
      createWorkflows,
      recordingBattleCommitments(),
      silentLogger,
    )

    const roomsChecked = await reconcile.execute(new Date('2026-09-21T10:05:01.000Z'))

    expect(roomsChecked).toBe(0)
    expect(await workflows.findByBattleAndPlayer(room.id, 'a1')).toBeNull()
  })

  it('un fallo al reconciliar una sala se registra y no detiene a las demas', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const room = finishedRoom()
    await rooms.save(room, 0)

    const brokenCreate = {
      execute: () => Promise.reject(new Error('fallo simulado')),
    } as unknown as CreateRewardWorkflows
    const errors: Record<string, unknown>[] = []
    const reconcile = new ReconcileRewardWorkflows(
      rooms,
      brokenCreate,
      recordingBattleCommitments(),
      {
        ...silentLogger,
        error: (_message: string, context: Record<string, unknown> = {}) => errors.push(context),
      },
    )

    const roomsChecked = await reconcile.execute(new Date('2026-09-21T00:00:00.000Z'))

    expect(roomsChecked).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ roomId: room.id })
  })

  /**
   * HU-29: `afterFinished` libera el compromiso sin esperar y el proceso puede
   * morir antes de que la llamada salga; la reconciliacion es el reintento. Es
   * seguro porque liberar es idempotente por contrato.
   */
  it('libera el compromiso de batalla de cada participante humano', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const room = finishedRoom()

    await rooms.save(room, 0)

    const commitments = recordingBattleCommitments()
    const reconcile = new ReconcileRewardWorkflows(
      rooms,
      new CreateRewardWorkflows(new InMemoryRewardWorkflowRepository()),
      commitments,
      silentLogger,
    )

    await reconcile.execute(new Date('2026-09-21T00:00:00.000Z'))

    expect(commitments.releases.map(({ playerId }) => playerId).sort()).toEqual(['a1', 'b1'])
    expect(new Set(commitments.releases.map(({ roomId }) => roomId))).toEqual(new Set([room.id]))
  })

  it('reintentar la reconciliacion vuelve a liberar: la liberacion es idempotente', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const room = finishedRoom()

    await rooms.save(room, 0)

    const commitments = recordingBattleCommitments()
    const reconcile = new ReconcileRewardWorkflows(
      rooms,
      new CreateRewardWorkflows(new InMemoryRewardWorkflowRepository()),
      commitments,
      silentLogger,
    )
    const since = new Date('2026-09-21T00:00:00.000Z')

    await reconcile.execute(since)
    await reconcile.execute(since)

    expect(commitments.releases).toHaveLength(4)
  })

  it('un fallo al liberar un participante se registra y NO impide liberar al resto ni crear el workflow', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    const room = finishedRoom()

    await rooms.save(room, 0)

    const commitments = recordingBattleCommitments()
    const inner = commitments.release.bind(commitments)

    commitments.release = (roomId, playerId) =>
      playerId === 'a1'
        ? Promise.reject(new UpstreamServiceError('player-inventory', 'no_alcanzable'))
        : inner(roomId, playerId)

    const workflows = new InMemoryRewardWorkflowRepository()
    const errors: Record<string, unknown>[] = []
    const reconcile = new ReconcileRewardWorkflows(
      rooms,
      new CreateRewardWorkflows(workflows),
      commitments,
      {
        ...silentLogger,
        error: (message: string, context: Record<string, unknown> = {}) =>
          errors.push({ message, ...context }),
      },
    )

    await reconcile.execute(new Date('2026-09-21T00:00:00.000Z'))

    expect(errors).toEqual([
      {
        message: 'battle_commitment_reconciliacion_fallo',
        roomId: room.id,
        playerId: 'a1',
        reason: 'UpstreamServiceError',
      },
    ])
    expect(commitments.releases.map(({ playerId }) => playerId)).toEqual(['b1'])
    expect(await workflows.findByBattleAndPlayer(room.id, 'a1')).not.toBeNull()
  })
})
