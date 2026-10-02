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
 *  - Se reparte en PARTES IGUALES entre TODOS los ganadores, con o sin
 *    apuesta propia (pasada de estabilizacion economica, seccion 7-10 del
 *    brief): arriesgar la propia apuesta nunca es requisito para cobrar lo
 *    que el rival perdio -- "cada participante arriesga UNICAMENTE su
 *    propia apuesta", no la del equipo contrario. Antes, un ganador sin
 *    apuesta propia excluia al pozo de cualquier destinatario (quedaba sin
 *    reparto y el perdedor recuperaba lo apostado): eso es precisamente la
 *    asimetria reportada en despliegue real (quien no aposto, o cuyo rival
 *    no aposto, no veia perder/ganar nada).
 *  - El resto no divisible (`pozo % n`) se reparte de a UN credito entre los
 *    ganadores de asiento (`seat`) mas bajo, en orden. Es la regla
 *    determinista elegida: no depende del orden de la cola de turnos ni de
 *    la aleatoriedad, y la suma acreditada siempre cuadra con la capturada.
 *  - Un perdedor CON apuesta se captura por el monto EXACTO de su hold.
 *  - Un ganador CON apuesta propia recibe su `holdId` como respaldo (Wallet
 *    libera su propia reserva en la misma entrada). Un ganador SIN apuesta
 *    propia recibe `holdId: null`: no tiene ninguna reserva que liberar, asi
 *    que Wallet lo acredita directamente (ver `StakeRepositoryPort.settle`),
 *    respaldado por la suma-cero contra lo capturado en la MISMA liquidacion.
 *
 * Devuelve `null` cuando no hay nada que liquidar: sin apuestas en absoluto,
 * o con `outcome !== 'WIN'` (un `NO_WINNER` se libera, nunca se liquida).
 */
export type StakeSettlementOutcome = 'CAPTURED' | 'CREDITED'

export interface StakeSettlementEntry {
  readonly playerId: string
  /** `null`: ganador SIN apuesta propia -- Wallet lo acredita sin referenciar ningun hold. */
  readonly holdId: string | null
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
  const stakeOfParticipant = (
    participant: BattleResult['participants'][number],
  ): StakeAtRisk | null =>
    stakeAt.get(`${participant.teamLabel}#${String(participant.seat)}`) ?? null

  // TODOS los ganadores participan del reparto (seccion 7-10): con apuesta
  // propia o sin ella. El orden de asiento decide a quien va el resto no
  // divisible, igual que antes.
  const winners = result.participants
    .filter((participant) => participant.result === 'WON')
    .map((participant) => ({ participant, stake: stakeOfParticipant(participant) }))
    .sort((a, b) => a.participant.seat - b.participant.seat)

  const losers = result.participants
    .filter((participant) => participant.result === 'LOST')
    .map((participant) => stakeOfParticipant(participant))
    .filter((stake): stake is StakeAtRisk => stake !== null)

  const pool = losers.reduce((total, stake) => total + stake.amount, 0)

  // `winners` nunca esta vacio con `outcome: 'WIN'` (siempre hay al menos un
  // participante `WON`); y `stakes.length > 0` (comprobado arriba) garantiza
  // que SIEMPRE hay algo que liquidar -- o el pozo de un perdedor, o la
  // propia reserva de un ganador que si aposto. Nunca null a partir de aqui.
  const share = Math.floor(pool / winners.length)
  const remainder = pool % winners.length

  const captured: StakeSettlementEntry[] = losers.map((stake) => ({
    playerId: stake.playerId,
    holdId: stake.holdOperationId,
    outcome: 'CAPTURED',
    amount: stake.amount,
  }))

  const credited: StakeSettlementEntry[] = winners
    .map(({ participant, stake }, index) => ({
      playerId: stake?.playerId ?? requirePlayerId(participant),
      holdId: stake?.holdOperationId ?? null,
      outcome: 'CREDITED' as const,
      amount: share + (index < remainder ? 1 : 0),
    }))
    // Un ganador CON apuesta propia siempre se incluye (aunque le toque 0):
    // Wallet debe liberar su propia reserva. Un ganador SIN apuesta propia
    // solo se incluye si de verdad cobra algo -- no existe ningun hold suyo
    // que liberar, y una entrada en 0 sin respaldo no aporta nada.
    .filter((entry) => entry.holdId !== null || entry.amount > 0)

  return { entries: [...captured, ...credited] }
}

/**
 * Un ganador sin apuesta propia todavia necesita un `playerId` para que
 * Wallet sepa a quien acreditar. `BattleResult.participants[].playerId` es
 * `null` SOLO para un `AI` (nunca tiene cuenta de Wallet) -- un `AI` jamas
 * puede estar en `winners` con `stake === null` Y necesitar credito, porque
 * un `AI` tampoco puede apostar; si de todos modos llegara aqui es un error
 * de invariante del propio resultado, no un caso de negocio valido.
 */
const requirePlayerId = (participant: BattleResult['participants'][number]): string => {
  if (participant.playerId === null) {
    throw new Error(
      `Un ganador sin playerId (${participant.teamLabel}#${String(participant.seat)}) no puede recibir credito de apuestas.`,
    )
  }

  return participant.playerId
}
