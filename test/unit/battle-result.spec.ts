import { parseBattleResult } from '../../src/domain/entities/BattleResult'
import { DomainError } from '../../src/domain/errors/DomainError'

const participantOf = (teamLabel: string, seat: number): Record<string, unknown> => ({
  teamLabel,
  seat,
  kind: 'HUMAN',
  playerId: `${teamLabel.toLowerCase()}${String(seat + 1)}`,
  displayName: `Nombre ${teamLabel}${String(seat + 1)}`,
  heroId: `hero-${teamLabel.toLowerCase()}${String(seat + 1)}`,
  result: teamLabel === 'B' ? 'WON' : 'LOST',
})

const noWinnerParticipants = (): Record<string, unknown>[] => [
  { ...participantOf('A', 0), result: 'NO_WINNER' },
  { ...participantOf('B', 0), result: 'NO_WINNER' },
]

/** Resultado VALIDO de referencia (contrato `hu-21-battle-finish-v1`, §5). */
const validResult = (): Record<string, unknown> => ({
  reason: 'TIME_LIMIT',
  outcome: 'WIN',
  winnerTeamLabel: 'B',
  finishedAt: '2026-09-21T10:06:00.000Z',
  tiebreak: 'ABSOLUTE_LIFE',
  disconnected: null,
  teams: [
    { teamLabel: 'A', remainingHealth: 22, maxHealth: 44, lifePercent: 50, eliminated: false },
    { teamLabel: 'B', remainingHealth: 25, maxHealth: 50, lifePercent: 50, eliminated: false },
  ],
  participants: [participantOf('A', 0), participantOf('B', 0)],
})

const withOverride = (override: Record<string, unknown>): Record<string, unknown> => ({
  ...validResult(),
  ...override,
})

/**
 * Validador del resultado (contrato §5 y §12): acepta lo valido y rechaza CADA
 * incoherencia. Es la puerta por la que pasa el JSON persistido al restaurar, y
 * tambien la que usa la validacion de la migracion `009`.
 */
describe('parseBattleResult — acepta el resultado valido', () => {
  it('cada causa del contrato con su coherencia', () => {
    const elimination = withOverride({
      reason: 'ELIMINATION',
      tiebreak: null,
    })
    const disconnection = withOverride({
      reason: 'DISCONNECTION',
      tiebreak: null,
      disconnected: { teamLabel: 'A', seat: 0 },
    })
    const noWinner = withOverride({
      outcome: 'NO_WINNER',
      winnerTeamLabel: null,
      tiebreak: null,
      teams: [
        { teamLabel: 'A', remainingHealth: 22, maxHealth: 44, lifePercent: 50, eliminated: false },
        { teamLabel: 'B', remainingHealth: 22, maxHealth: 44, lifePercent: 50, eliminated: false },
      ],
      participants: noWinnerParticipants(),
    })

    for (const raw of [validResult(), elimination, disconnection, noWinner]) {
      expect(parseBattleResult(raw)).toEqual(raw)
    }
  })
})

describe('parseBattleResult — rechaza cada incoherencia', () => {
  it.each([
    ['WIN sin ganador', { winnerTeamLabel: null }],
    ['WIN con un ganador que no es equipo', { winnerTeamLabel: 'C' }],
    ['NO_WINNER con ganador', { outcome: 'NO_WINNER', participants: noWinnerParticipants() }],
    ['una causa desconocida', { reason: 'SURRENDER' }],
    ['un desempate en una eliminacion', { reason: 'ELIMINATION', tiebreak: 'LIFE_PERCENT' }],
    [
      'un desempate sin ganador',
      {
        outcome: 'NO_WINNER',
        winnerTeamLabel: null,
        tiebreak: 'LIFE_PERCENT',
        participants: noWinnerParticipants(),
      },
    ],
    ['un desempate desconocido', { tiebreak: 'COIN_FLIP' }],
    [
      'solo un equipo',
      {
        teams: [
          {
            teamLabel: 'A',
            remainingHealth: 22,
            maxHealth: 44,
            lifePercent: 50,
            eliminated: false,
          },
        ],
      },
    ],
    [
      'tres equipos',
      {
        teams: [
          {
            teamLabel: 'A',
            remainingHealth: 22,
            maxHealth: 44,
            lifePercent: 50,
            eliminated: false,
          },
          {
            teamLabel: 'B',
            remainingHealth: 25,
            maxHealth: 50,
            lifePercent: 50,
            eliminated: false,
          },
          { teamLabel: 'C', remainingHealth: 1, maxHealth: 1, lifePercent: 100, eliminated: false },
        ],
      },
    ],
    [
      'vida restante mayor que la maxima',
      {
        teams: [
          {
            teamLabel: 'A',
            remainingHealth: 45,
            maxHealth: 44,
            lifePercent: 50,
            eliminated: false,
          },
          {
            teamLabel: 'B',
            remainingHealth: 25,
            maxHealth: 50,
            lifePercent: 50,
            eliminated: false,
          },
        ],
      },
    ],
    [
      'un participante de un equipo ajeno',
      { participants: [{ ...participantOf('A', 0), teamLabel: 'C' }, participantOf('B', 0)] },
    ],
    [
      'un participante con el resultado que no le toca',
      { participants: [{ ...participantOf('A', 0), result: 'WON' }, participantOf('B', 0)] },
    ],
    [
      'un NO_WINNER con un participante ganador',
      {
        outcome: 'NO_WINNER',
        winnerTeamLabel: null,
        tiebreak: null,
        participants: [{ ...participantOf('A', 0), result: 'WON' }, participantOf('B', 0)],
      },
    ],
    ['DISCONNECTION sin desconectado', { reason: 'DISCONNECTION', tiebreak: null }],
    [
      'ELIMINATION con desconectado',
      { reason: 'ELIMINATION', tiebreak: null, disconnected: { teamLabel: 'A', seat: 0 } },
    ],
    [
      'un desconectado que es el ganador',
      { reason: 'DISCONNECTION', tiebreak: null, disconnected: { teamLabel: 'B', seat: 0 } },
    ],
    ['un instante final invalido', { finishedAt: 'ayer' }],
    ['ningun participante', { participants: [] }],
    [
      'una posicion negativa',
      { participants: [{ ...participantOf('A', 0), seat: -1 }, participantOf('B', 0)] },
    ],
    [
      'una vida no entera',
      {
        teams: [
          {
            teamLabel: 'A',
            remainingHealth: 22.5,
            maxHealth: 44,
            lifePercent: 50,
            eliminated: false,
          },
          {
            teamLabel: 'B',
            remainingHealth: 25,
            maxHealth: 50,
            lifePercent: 50,
            eliminated: false,
          },
        ],
      },
    ],
    [
      'un porcentaje fuera de rango',
      {
        teams: [
          {
            teamLabel: 'A',
            remainingHealth: 22,
            maxHealth: 44,
            lifePercent: 120,
            eliminated: false,
          },
          {
            teamLabel: 'B',
            remainingHealth: 25,
            maxHealth: 50,
            lifePercent: 50,
            eliminated: false,
          },
        ],
      },
    ],
    [
      'un participante sin tipo reconocido',
      { participants: [{ ...participantOf('A', 0), kind: 'BOT' }, participantOf('B', 0)] },
    ],
  ])('rechaza %s', (_label, override) => {
    expect(() => parseBattleResult(withOverride(override))).toThrow(DomainError)
  })

  it('rechaza una entrada que no es un objeto', () => {
    expect(() => parseBattleResult('resultado')).toThrow(DomainError)
    expect(() => parseBattleResult(null)).toThrow(DomainError)
  })
})
