import { InvalidBattleRosterError } from '../errors/BattleErrors'
import {
  memberKey,
  type RosterMember,
  type TeamRoster,
  type TurnOrderEntry,
} from '../entities/TurnOrder'

/**
 * Fuente de enteros uniformes acotados que necesita la generacion del orden.
 *
 * Es una abstraccion de DOMINIO: el dominio no conoce el motor pseudoaleatorio
 * (HU-24). Quien la implementa (capa de aplicacion) la construye sobre
 * `RandomSequencePort.nextIndex()` con muestreo por rechazo, sin sesgo.
 */
export interface BoundedRandom {
  /** Entero uniforme en `[0, bound)`. `bound` es un entero >= 1. */
  nextInt(bound: number): number
}

/**
 * Baraja UNA copia de `items` con Fisher-Yates usando enteros uniformes
 * acotados. Consume exactamente `items.length - 1` selecciones (mas los
 * rechazos internos de la fuente).
 */
const shuffle = <T>(items: readonly T[], random: BoundedRandom): T[] => {
  const result = [...items]

  for (let index = result.length - 1; index >= 1; index -= 1) {
    const swapWith = random.nextInt(index + 1)
    const current = result[index] as T

    result[index] = result[swapWith] as T
    result[swapWith] = current
  }

  return result
}

const assertValidRoster = (rosters: readonly [TeamRoster, TeamRoster]): void => {
  if (rosters[0].label === rosters[1].label) {
    throw new InvalidBattleRosterError('Los dos equipos de la cola necesitan etiquetas distintas.')
  }

  const seen = new Set<string>()
  const humans = new Set<string>()

  for (const roster of rosters) {
    if (roster.members.length === 0) {
      throw new InvalidBattleRosterError(`El equipo ${roster.label} no tiene participantes.`)
    }

    for (const member of roster.members) {
      if (member.teamLabel !== roster.label) {
        throw new InvalidBattleRosterError(
          `El participante ${memberKey(member)} no pertenece al equipo ${roster.label}.`,
        )
      }

      const key = memberKey(member)

      if (seen.has(key)) {
        throw new InvalidBattleRosterError(`El participante ${key} esta duplicado.`)
      }
      seen.add(key)

      if (member.playerId !== null) {
        if (humans.has(member.playerId)) {
          throw new InvalidBattleRosterError(
            `El jugador "${member.playerId}" aparece mas de una vez en la cola.`,
          )
        }
        humans.add(member.playerId)
      }
    }
  }
}

/**
 * Genera la cola de turnos inicial de una batalla (HU-17, RF-17).
 *
 *  1. Equipo inicial: un entero uniforme en `{0, 1}` (0 = el primer equipo
 *     recibido).
 *  2. Cada equipo se baraja con Fisher-Yates (decisiones aleatorias de HU-24).
 *  3. Se intercalan los equipos empezando por el equipo inicial, alternando
 *     mientras ambos tengan participantes.
 *  4. Si un equipo se agota antes (composiciones desiguales), los que restan
 *     del otro equipo se anaden a continuacion, en su orden barajado
 *     (decision tecnica pendiente de ratificar: RF-17 solo define la
 *     alternancia para equipos equilibrados).
 *
 * Las estadisticas, el nivel, el Poder, el tipo de heroe y el equipamiento NO
 * intervienen: la funcion ni siquiera recibe esos datos. Es PURA respecto a la
 * aleatoriedad: la unica fuente es `random`, inyectada. La cola resultante es
 * la definitiva; no se vuelve a sortear.
 *
 * Orden de las selecciones (documentado para las pruebas): primero el equipo
 * inicial, luego el barajado del primer equipo recibido y despues el del
 * segundo.
 */
export const generateTurnOrder = (
  rosters: readonly [TeamRoster, TeamRoster],
  random: BoundedRandom,
): readonly TurnOrderEntry[] => {
  assertValidRoster(rosters)

  const startingIndex = random.nextInt(2)
  const shuffled: readonly [RosterMember[], RosterMember[]] = [
    shuffle(rosters[0].members, random),
    shuffle(rosters[1].members, random),
  ]
  const order: TurnOrderEntry[] = []
  const queues: readonly [RosterMember[], RosterMember[]] =
    startingIndex === 0 ? [shuffled[0], shuffled[1]] : [shuffled[1], shuffled[0]]
  const longest = Math.max(queues[0].length, queues[1].length)

  for (let round = 0; round < longest; round += 1) {
    for (const queue of queues) {
      const member = queue[round]

      if (member !== undefined) {
        order.push(member)
      }
    }
  }

  return order
}
