import type { BattleResult } from '../entities/BattleResult'
import type { StakeAtRisk } from '../value-objects/ParticipantStake'

/**
 * Reparto del pozo de una batalla con ganador (HU-23, contrato
 * `hu-23-battle-stake-v1` §2 D2 y §5.3). PURA: sin reloj, sin HTTP y sin
 * azar — mismo criterio que `BattleCreditsPolicy`/`BattleOutcomePolicy`.
 *
 * Reglas:
 *
 *  - El pozo es la suma de lo apostado por el equipo PERDEDOR.
 *  - Se reparte en PARTES IGUALES entre los ganadores CON apuesta (D2): un
 *    ganador que no aposto no recibe nada del pozo (tampoco pierde).
 *  - El resto no divisible (`pozo % n`) se reparte de a UN credito entre los
 *    ganadores con apuesta de asiento (`seat`) mas bajo, en orden. Es la
 *    regla determinista elegida: no depende del orden de la cola de turnos
 *    ni de la aleatoriedad, y la suma acreditada siempre cuadra con la
 *    capturada.
 *  - Un perdedor CON apuesta se captura por el monto EXACTO de su hold.
 *
 * Devuelve `null` cuando no hay nada que liquidar: sin apuestas, con
 * `outcome !== 'WIN'` (un `NO_WINNER` se libera, nunca se liquida), o cuando
 * NADIE del equipo ganador aposto. Ese ultimo caso lo decide el llamador
 * (no hay destinatario posible para el pozo: se libera en vez de capturar
 * sin contrapartida, que violaria la suma cero de Wallet).
 */
export type StakeSettlementOutcome = 'CAPTURED' | 'CREDITED'

export interface StakeSettlementEntry {
  readonly playerId: string
  readonly holdId: string
  readonly outcome: StakeSettlementOutcome
  readonly amount: number
}

export interface StakeSettlement {
  readonly entries: readonly StakeSettlementEntry[]
}

export const stakeSettlementFor = (
  result: BattleResult,
  stakes: readonly StakeAtRisk[],
): StakeSettlement | null => {
  if (result.outcome !== 'WIN' || stakes.length === 0) {
    return null
  }

  const stakeAt = new Map(
    stakes.map((stake) => [`${stake.teamLabel}#${String(stake.seat)}`, stake]),
  )
  const participantStake = (
    participant: BattleResult['participants'][number],
  ): StakeAtRisk | null =>
    stakeAt.get(`${participant.teamLabel}#${String(participant.seat)}`) ?? null

  const winners = result.participants
    .filter((participant) => participant.result === 'WON')
    .map((participant) => participantStake(participant))
    .filter((stake): stake is StakeAtRisk => stake !== null)

  if (winners.length === 0) {
    return null
  }

  const losers = result.participants
    .filter((participant) => participant.result === 'LOST')
    .map((participant) => participantStake(participant))
    .filter((stake): stake is StakeAtRisk => stake !== null)

  const pool = losers.reduce((total, stake) => total + stake.amount, 0)
  const share = Math.floor(pool / winners.length)
  const remainder = pool % winners.length
  const bySeat = [...winners].sort((a, b) => a.seat - b.seat)

  const captured: StakeSettlementEntry[] = losers.map((stake) => ({
    playerId: stake.playerId,
    holdId: stake.holdOperationId,
    outcome: 'CAPTURED',
    amount: stake.amount,
  }))

  const credited: StakeSettlementEntry[] = bySeat.map((stake, index) => ({
    playerId: stake.playerId,
    holdId: stake.holdOperationId,
    outcome: 'CREDITED',
    amount: share + (index < remainder ? 1 : 0),
  }))

  return { entries: [...captured, ...credited] }
}
