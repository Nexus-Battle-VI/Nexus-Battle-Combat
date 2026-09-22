import { InMemoryRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryRewardWorkflowRepository'
import type { BattleFinishedNotification } from '../../src/application/ports/BattleResultPublisherPort'
import {
  CreateRewardWorkflows,
  inventoryOperationIdOf,
  walletOperationIdOf,
} from '../../src/application/use-cases/CreateRewardWorkflows'
import { RewardWorkflowState } from '../../src/domain/value-objects/RewardWorkflowState'

const notification = (
  overrides: Partial<BattleFinishedNotification> = {},
): BattleFinishedNotification => ({
  roomId: 'room-1',
  mode: 'PVP',
  finishedAt: '2026-09-22T10:06:00.000Z',
  reason: 'ELIMINATION',
  outcome: 'WIN',
  winnerTeamLabel: 'A',
  participants: [
    {
      kind: 'HUMAN',
      playerId: 'sub-winner',
      heroId: 'hero-1',
      teamLabel: 'A',
      seat: 0,
      result: 'WON',
      credits: 2,
    },
    {
      kind: 'HUMAN',
      playerId: 'sub-loser',
      heroId: 'hero-2',
      teamLabel: 'B',
      seat: 0,
      result: 'LOST',
      credits: 1,
    },
    {
      kind: 'AI',
      playerId: null,
      heroId: 'hero-3',
      teamLabel: 'B',
      seat: 1,
      result: 'LOST',
      credits: null,
    },
  ],
  configuredReward: { amount: 0 },
  ...overrides,
})

describe('CreateRewardWorkflows', () => {
  it('crea un workflow PENDING_CREDIT por participante HUMANO con credits', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const useCase = new CreateRewardWorkflows(repository)

    const created = await useCase.execute(notification())

    expect(created).toHaveLength(2)
    expect(created.every((workflow) => workflow.state === RewardWorkflowState.PendingCredit)).toBe(
      true,
    )
  })

  it('el ganador recibe victoryCreditsAmount igual a sus creditos; el perdedor, 0', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const useCase = new CreateRewardWorkflows(repository)

    const [winner, loser] = await useCase.execute(notification())

    expect(winner).toMatchObject({
      playerId: 'sub-winner',
      creditsAmount: 2,
      victoryCreditsAmount: 2,
    })
    expect(loser).toMatchObject({
      playerId: 'sub-loser',
      creditsAmount: 1,
      victoryCreditsAmount: 0,
    })
  })

  it('un participante AI (sin playerId ni credits) no genera workflow', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const useCase = new CreateRewardWorkflows(repository)

    const created = await useCase.execute(notification())

    // El AI de la fixture esta en teamLabel 'B', seat 1: ningun workflow
    // creado debe corresponder a esa posicion.
    expect(created.some((workflow) => workflow.teamLabel === 'B' && workflow.seat === 1)).toBe(
      false,
    )
    expect(created).toHaveLength(2)
  })

  it('los operationId son deterministas: mismo battle+player siempre igual', () => {
    expect(walletOperationIdOf('room-1', 'sub-1')).toBe('battle:room-1:player:sub-1:credit')
    expect(walletOperationIdOf('room-1', 'sub-1')).toBe(walletOperationIdOf('room-1', 'sub-1'))
    expect(inventoryOperationIdOf('room-1', 'sub-1')).toBe(
      'battle:room-1:player:sub-1:chest:1:grant',
    )
  })

  it('una notificacion repetida (HU-21 "al menos una vez") no duplica el workflow', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const useCase = new CreateRewardWorkflows(repository)

    const first = await useCase.execute(notification())
    const replay = await useCase.execute(notification())

    // Identidad de objeto, no solo igualdad de valores: si `createIfAbsent`
    // recreara el workflow en el replay (bug de duplicado), devolveria una
    // instancia NUEVA aunque sus campos coincidieran por casualidad.
    expect(replay[0]).toBe(first[0])
    expect(await repository.findByBattleAndPlayer('room-1', 'sub-winner')).toBe(first[0])
  })

  it('un empate total (NO_WINNER) no cuenta como victoria para el progreso', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const useCase = new CreateRewardWorkflows(repository)

    const created = await useCase.execute(
      notification({
        outcome: 'NO_WINNER',
        winnerTeamLabel: null,
        participants: [
          {
            kind: 'HUMAN',
            playerId: 'sub-a',
            heroId: 'hero-a',
            teamLabel: 'A',
            seat: 0,
            result: 'NO_WINNER',
            credits: 1,
          },
        ],
      }),
    )

    expect(created[0]).toMatchObject({ creditsAmount: 1, victoryCreditsAmount: 0 })
  })
})
