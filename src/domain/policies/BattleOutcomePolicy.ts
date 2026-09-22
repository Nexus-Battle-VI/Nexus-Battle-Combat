import type { Combatant } from '../entities/Combatant'
import type { TiebreakRule } from '../entities/BattleResult'

/**
 * Reglas de resultado de una batalla (HU-21, contrato
 * `hu-21-battle-finish-v1`, §4). PURO: recibe datos ya leidos del estado y no
 * toca el reloj, el azar ni la persistencia.
 *
 * La comparacion de porcentajes es ENTERA por producto cruzado (contrato §4.3):
 * `restanteA * maximaB` contra `restanteB * maximaA`. Nunca se comparan
 * decimales, para que 1/3 contra 33/99 no dependa del redondeo de coma flotante.
 */

/** Vida agregada de un equipo, con la informacion necesaria para decidir. */
export interface TeamLife {
  readonly teamLabel: string
  /** Suma de la Vida actual de los combatientes con Vida del equipo. */
  readonly remaining: number
  /** Suma de la Vida maxima de esos mismos combatientes. */
  readonly max: number
  /** `true` si todos sus combatientes tienen Vida y los perdieron todos. */
  readonly allEliminated: boolean
  /**
   * `true` si el equipo tiene al menos un combatiente y TODOS tienen Vida; solo
   * entonces la regla de vida es calculable. Una batalla anterior a HU-18 (sin
   * snapshot) o un equipo con un participante sin perfil (`AI`) no lo cumplen.
   */
  readonly hasLifeData: boolean
}

const EMPTY_TEAM_LIFE = (teamLabel: string): TeamLife => ({
  teamLabel,
  remaining: 0,
  max: 0,
  allEliminated: false,
  hasLifeData: false,
})

/**
 * Vida agregada de cada equipo (contrato §4.3, paso 1). Un combatiente sin Vida
 * (perfil `null`, p. ej. `AI`) aporta a `remaining`/`max` lo mismo que un
 * participante inexistente: nada, y ademas hace que el equipo no tenga datos de
 * Vida utilizables (contrato §4.1: impide su eliminacion).
 */
export const teamLives = (
  combatants: readonly Combatant[] | null,
  teamLabels: readonly [string, string],
): readonly [TeamLife, TeamLife] => {
  const lifeOf = (teamLabel: string): TeamLife => {
    if (combatants === null) {
      return EMPTY_TEAM_LIFE(teamLabel)
    }

    const members = combatants.filter((combatant) => combatant.teamLabel === teamLabel)
    const withLife = members.filter(
      (combatant) => combatant.profile !== null && combatant.currentHealth !== null,
    )
    const hasLifeData = members.length > 0 && withLife.length === members.length

    if (!hasLifeData) {
      return EMPTY_TEAM_LIFE(teamLabel)
    }

    return {
      teamLabel,
      remaining: withLife.reduce((total, combatant) => total + (combatant.currentHealth ?? 0), 0),
      max: withLife.reduce((total, combatant) => total + (combatant.profile?.maxHealth ?? 0), 0),
      allEliminated: withLife.every((combatant) => combatant.currentHealth === 0),
      hasLifeData: true,
    }
  }

  return [lifeOf(teamLabels[0]), lifeOf(teamLabels[1])]
}

/**
 * El equipo eliminado, o `null` si ninguno lo esta. Un equipo solo puede estar
 * eliminado si TODOS sus combatientes tienen Vida (`hasLifeData`) y todos
 * bajaron a 0; un participante sin perfil impide la eliminacion de su equipo.
 */
export const findEliminatedTeam = (lives: readonly [TeamLife, TeamLife]): string | null => {
  const eliminated = lives.find((team) => team.allEliminated)

  return eliminated === undefined ? null : eliminated.teamLabel
}

export interface TimeLimitResolution {
  readonly winnerTeamLabel: string | null
  readonly tiebreak: TiebreakRule | null
}

const NOT_RESOLVED: TimeLimitResolution = { winnerTeamLabel: null, tiebreak: null }

/**
 * Ganador del vencimiento global (contrato §4.3):
 *
 *  1. Mayor PORCENTAJE de vida restante, comparado con producto cruzado entero.
 *  2. Mismo porcentaje: mayor vida restante ABSOLUTA (solicitud del PO).
 *  3. Mismo porcentaje y misma vida: `NO_WINNER` (pendiente del PO, no se
 *     inventa un desempate).
 *  4. Sin datos de Vida calculables en algun equipo: `NO_WINNER`.
 */
export const resolveTimeLimit = (a: TeamLife, b: TeamLife): TimeLimitResolution => {
  if (!a.hasLifeData || !b.hasLifeData) {
    return NOT_RESOLVED
  }

  const left = a.remaining * b.max
  const right = b.remaining * a.max

  if (left > right) {
    return { winnerTeamLabel: a.teamLabel, tiebreak: 'LIFE_PERCENT' }
  }

  if (right > left) {
    return { winnerTeamLabel: b.teamLabel, tiebreak: 'LIFE_PERCENT' }
  }

  if (a.remaining > b.remaining) {
    return { winnerTeamLabel: a.teamLabel, tiebreak: 'ABSOLUTE_LIFE' }
  }

  if (b.remaining > a.remaining) {
    return { winnerTeamLabel: b.teamLabel, tiebreak: 'ABSOLUTE_LIFE' }
  }

  return NOT_RESOLVED
}

/**
 * Porcentaje de vida para MOSTRAR, con dos decimales (contrato §4.3: el campo
 * `lifePercent` del resultado es solo para mostrar; la decision nunca lo usa).
 * `max = 0` se muestra como 0.
 */
export const lifePercentForDisplay = (remaining: number, max: number): number => {
  if (max <= 0) {
    return 0
  }

  return Math.round((remaining / max) * 10_000) / 100
}
