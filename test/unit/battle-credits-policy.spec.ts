import type {
  BattleResult,
  ParticipantOutcome,
  ParticipantResultKind,
} from '../../src/domain/entities/BattleResult'
import { creditEntitlements } from '../../src/domain/policies/BattleCreditsPolicy'

const human = (
  teamLabel: string,
  seat: number,
  result: ParticipantResultKind,
): ParticipantOutcome => ({
  teamLabel,
  seat,
  kind: 'HUMAN',
  playerId: `${teamLabel.toLowerCase()}${String(seat + 1)}`,
  displayName: `Nombre ${teamLabel}${String(seat + 1)}`,
  heroId: `hero-${teamLabel.toLowerCase()}${String(seat + 1)}`,
  result,
})

const ai = (teamLabel: string, seat: number): ParticipantOutcome => ({
  teamLabel,
  seat,
  kind: 'AI',
  playerId: null,
  displayName: null,
  heroId: null,
  result: 'LOST',
})

const resultWith = (
  participants: readonly ParticipantOutcome[],
  winnerTeamLabel: string | null,
): BattleResult => ({
  reason: winnerTeamLabel === null ? 'TIME_LIMIT' : 'ELIMINATION',
  outcome: winnerTeamLabel === null ? 'NO_WINNER' : 'WIN',
  winnerTeamLabel,
  finishedAt: '2026-09-21T10:06:00.000Z',
  tiebreak: null,
  disconnected: null,
  teams: [
    { teamLabel: 'A', remainingHealth: 0, maxHealth: 44, lifePercent: 0, eliminated: true },
    { teamLabel: 'B', remainingHealth: 44, maxHealth: 44, lifePercent: 100, eliminated: false },
  ],
  participants,
})

/**
 * Creditos del §7.6 como DERECHO (contrato `hu-21-battle-finish-v1`, §9):
 * 1 contra 1 -> 2 al ganador; por equipos -> 4 a cada ganador; el resto 1; un
 * empate -> 1 por participar. Combat no acredita nada: este numero solo viaja en
 * la notificacion a consumidores.
 */
describe('BattleCreditsPolicy — derechos de credito (contrato §9)', () => {
  it('1 contra 1: el ganador 2 y el perdedor 1', () => {
    const result = resultWith([human('A', 0, 'LOST'), human('B', 0, 'WON')], 'B')

    expect(creditEntitlements(result)).toEqual([
      { teamLabel: 'A', seat: 0, credits: 1 },
      { teamLabel: 'B', seat: 0, credits: 2 },
    ])
  })

  it('2 contra 2: 4 a cada ganador y 1 a cada perdedor', () => {
    const result = resultWith(
      [human('A', 0, 'LOST'), human('A', 1, 'LOST'), human('B', 0, 'WON'), human('B', 1, 'WON')],
      'B',
    )

    expect(creditEntitlements(result).map((entry) => entry.credits)).toEqual([1, 1, 4, 4])
  })

  it('3 contra 3: 4 a cada ganador y 1 a cada perdedor', () => {
    const result = resultWith(
      [
        human('A', 0, 'LOST'),
        human('A', 1, 'LOST'),
        human('A', 2, 'LOST'),
        human('B', 0, 'WON'),
        human('B', 1, 'WON'),
        human('B', 2, 'WON'),
      ],
      'B',
    )

    expect(creditEntitlements(result).map((entry) => entry.credits)).toEqual([1, 1, 1, 4, 4, 4])
  })

  it('NO_WINNER: 1 credito por participar para cada uno', () => {
    const all: ParticipantOutcome[] = [human('A', 0, 'NO_WINNER'), human('B', 0, 'NO_WINNER')]
    const result: BattleResult = {
      ...resultWith(all, null),
      teams: [
        { teamLabel: 'A', remainingHealth: 22, maxHealth: 44, lifePercent: 50, eliminated: false },
        { teamLabel: 'B', remainingHealth: 22, maxHealth: 44, lifePercent: 50, eliminated: false },
      ],
    }

    expect(creditEntitlements(result)).toEqual([
      { teamLabel: 'A', seat: 0, credits: 1 },
      { teamLabel: 'B', seat: 0, credits: 1 },
    ])
  })

  it('un participante AI no tiene derecho (null): no hay una persona a quien acreditar', () => {
    const result = resultWith([human('A', 0, 'WON'), ai('B', 0)], 'A')

    expect(creditEntitlements(result)).toEqual([
      { teamLabel: 'A', seat: 0, credits: 2 },
      { teamLabel: 'B', seat: 0, credits: null },
    ])
  })

  it('el desconectado que pierde cobra 1 como cualquier perdedor', () => {
    const result = resultWith([human('A', 0, 'LOST'), human('B', 0, 'WON')], 'B')

    expect(creditEntitlements(result)).toContainEqual({ teamLabel: 'A', seat: 0, credits: 1 })
  })
})
