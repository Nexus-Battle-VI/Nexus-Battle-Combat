import { Combatant } from '../../src/domain/entities/Combatant'
import { createCombatProfile } from '../../src/domain/entities/CombatProfile'
import {
  findEliminatedTeam,
  lifePercentForDisplay,
  resolveTimeLimit,
  teamLives,
  type TeamLife,
} from '../../src/domain/policies/BattleOutcomePolicy'

/** Combatiente con Vida y maximo controlados, sin estado de habilidades. */
const withLife = (
  teamLabel: string,
  seat: number,
  currentHealth: number,
  maxHealth = currentHealth,
): Combatant =>
  Combatant.restore({
    teamLabel,
    seat,
    currentHealth,
    profile: createCombatProfile({
      heroId: `hero-${teamLabel}${String(seat)}`,
      subtype: 'GUERRERO_ARMAS',
      maxHealth,
      attack: 10,
      defense: 5,
      damage: { mode: 'DICE', count: 1, sides: 4 },
      activeEffects: [],
    }),
  })

/** Participante sin perfil (`AI`): no tiene Vida y no se le inventa. */
const withoutLife = (teamLabel: string, seat: number): Combatant =>
  Combatant.restore({ teamLabel, seat, currentHealth: null, profile: null })

const life = (
  teamLabel: string,
  remaining: number,
  max: number,
  allEliminated = false,
): TeamLife => ({
  teamLabel,
  remaining,
  max,
  allEliminated,
  hasLifeData: true,
})

describe('BattleOutcomePolicy — vida agregada (contrato §4.3)', () => {
  it('suma todos los combatientes con Vida del equipo: el eliminado aporta 0 a la restante y su maxima cuenta', () => {
    const lives = teamLives(
      [withLife('A', 0, 0, 44), withLife('A', 1, 22, 44), withLife('B', 0, 25, 50)],
      ['A', 'B'],
    )

    expect(lives).toEqual([
      { teamLabel: 'A', remaining: 22, max: 88, allEliminated: false, hasLifeData: true },
      { teamLabel: 'B', remaining: 25, max: 50, allEliminated: false, hasLifeData: true },
    ])
  })

  it('sin snapshot de combate (batalla anterior a HU-18) no hay datos de Vida', () => {
    expect(teamLives(null, ['A', 'B'])).toEqual([
      { teamLabel: 'A', remaining: 0, max: 0, allEliminated: false, hasLifeData: false },
      { teamLabel: 'B', remaining: 0, max: 0, allEliminated: false, hasLifeData: false },
    ])
  })

  it('un equipo con un participante sin perfil no tiene datos de Vida utilizables', () => {
    const lives = teamLives([withLife('A', 0, 10, 44), withoutLife('A', 1)], ['A', 'B'])

    expect(lives[0]).toEqual({
      teamLabel: 'A',
      remaining: 0,
      max: 0,
      allEliminated: false,
      hasLifeData: false,
    })
  })
})

describe('BattleOutcomePolicy — eliminacion (contrato §4.1)', () => {
  it('un equipo esta eliminado solo si TODOS sus combatientes con Vida bajaron a 0', () => {
    const lives = teamLives([withLife('A', 0, 0, 44), withLife('A', 1, 0, 44)], ['A', 'B'])

    expect(findEliminatedTeam(lives)).toBe('A')
  })

  it('un companero con Vida impide la eliminacion del equipo', () => {
    const lives = teamLives([withLife('A', 0, 0, 44), withLife('A', 1, 3, 44)], ['A', 'B'])

    expect(findEliminatedTeam(lives)).toBeNull()
  })

  it('un participante sin perfil (AI) impide la eliminacion de su equipo', () => {
    const lives = teamLives([withLife('A', 0, 0, 44), withoutLife('A', 1)], ['A', 'B'])

    expect(findEliminatedTeam(lives)).toBeNull()
  })

  it('sin datos de Vida no hay eliminacion', () => {
    expect(findEliminatedTeam(teamLives(null, ['A', 'B']))).toBeNull()
  })
})

describe('BattleOutcomePolicy — vencimiento global (contrato §4.3, S-10 a S-14)', () => {
  it('S-10: porcentajes distintos -> gana el mayor porcentaje (LIFE_PERCENT)', () => {
    expect(resolveTimeLimit(life('A', 30, 44), life('B', 25, 50))).toEqual({
      winnerTeamLabel: 'A',
      tiebreak: 'LIFE_PERCENT',
    })
  })

  it('S-12: mismo porcentaje y vida absoluta distinta -> gana la mayor vida (ABSOLUTE_LIFE, 22/44 contra 25/50)', () => {
    expect(resolveTimeLimit(life('A', 22, 44), life('B', 25, 50))).toEqual({
      winnerTeamLabel: 'B',
      tiebreak: 'ABSOLUTE_LIFE',
    })
  })

  it('S-13: mismo porcentaje y misma vida -> NO_WINNER (sin desempate inventado)', () => {
    expect(resolveTimeLimit(life('A', 22, 44), life('B', 22, 44))).toEqual({
      winnerTeamLabel: null,
      tiebreak: null,
    })
  })

  it('S-13 (nadie ataco): ambos al 100 % con la misma Vida maxima -> NO_WINNER', () => {
    expect(resolveTimeLimit(life('A', 44, 44), life('B', 44, 44))).toEqual({
      winnerTeamLabel: null,
      tiebreak: null,
    })
  })

  it('S-14: la comparacion es ENTERA por producto cruzado (1/3 contra 33/99 no depende de decimales)', () => {
    expect(resolveTimeLimit(life('A', 1, 3), life('B', 33, 99))).toEqual({
      winnerTeamLabel: 'B',
      tiebreak: 'ABSOLUTE_LIFE',
    })
  })

  it('sin datos de Vida en algun equipo -> NO_WINNER (contrato §4.3, punto 5)', () => {
    const noData: TeamLife = {
      teamLabel: 'B',
      remaining: 0,
      max: 0,
      allEliminated: false,
      hasLifeData: false,
    }

    expect(resolveTimeLimit(life('A', 10, 40), noData)).toEqual({
      winnerTeamLabel: null,
      tiebreak: null,
    })
    expect(resolveTimeLimit(noData, life('A', 10, 40))).toEqual({
      winnerTeamLabel: null,
      tiebreak: null,
    })
  })

  it('comparaciones grandes siguen siendo exactas (productos cruzados sin perder precision)', () => {
    expect(
      resolveTimeLimit(life('A', 999_999, 1_000_000), life('B', 1_000_000, 1_000_001)),
    ).toEqual({
      winnerTeamLabel: 'B',
      tiebreak: 'LIFE_PERCENT',
    })
  })
})

describe('BattleOutcomePolicy — porcentaje solo para mostrar', () => {
  it.each([
    [22, 44, 50],
    [25, 50, 50],
    [1, 3, 33.33],
    [0, 44, 0],
    [10, 40, 25],
  ])('lifePercentForDisplay(%i, %i) = %d', (remaining, max, expected) => {
    expect(lifePercentForDisplay(remaining, max)).toBe(expected)
  })

  it('con vida maxima 0 muestra 0 en vez de dividir por cero', () => {
    expect(lifePercentForDisplay(0, 0)).toBe(0)
  })
})
