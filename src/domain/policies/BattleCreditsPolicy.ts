import type { BattleResult } from '../entities/BattleResult'

/**
 * Creditos que la partida otorga por DERECHO (HU-21, contrato
 * `hu-21-battle-finish-v1`, §9).
 *
 * §7.6 del documento oficial: el ganador recibe 2 creditos si la partida es 1
 * contra 1, o 4 si es de equipos; los demas reciben 1 por participar. Un
 * empate total deja 1 a cada uno.
 *
 * IMPORTANTE: esto NO acredita nada. Combat no tiene API de acreditacion y Web
 * no los muestra como concedidos: el numero viaja como derecho en la
 * notificacion a los consumidores (HU-22/23/30/09) y la entrega real es de
 * esas historias. Un participante `AI` no recibe credito.
 */
export interface CreditEntitlement {
  readonly teamLabel: string
  readonly seat: number
  readonly credits: number | null
}

/** Creditos por participante, en el mismo orden que `result.participants`. */
export const creditEntitlements = (result: BattleResult): readonly CreditEntitlement[] => {
  const perTeam = new Map<string, number>()

  for (const participant of result.participants) {
    perTeam.set(participant.teamLabel, (perTeam.get(participant.teamLabel) ?? 0) + 1)
  }

  const isDuel = perTeam.size === 2 && [...perTeam.values()].every((count) => count === 1)

  return result.participants.map((participant) => ({
    teamLabel: participant.teamLabel,
    seat: participant.seat,
    credits: participant.kind === 'AI' ? null : participant.result === 'WON' ? (isDuel ? 2 : 4) : 1,
  }))
}
