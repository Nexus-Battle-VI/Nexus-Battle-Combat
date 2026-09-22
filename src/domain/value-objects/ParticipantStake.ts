import { DomainError } from '../errors/DomainError'
import { InvalidStakeAmountError } from '../errors/StakeErrors'

/**
 * Apuesta de un participante (HU-23, contrato `hu-23-battle-stake-v1` §4.2).
 *
 * `PENDING_RESERVE` y `RESERVE_FAILED` forman parte del vocabulario del
 * contrato, pero con D8 (reserva SINCRONA antes de persistir) nunca llegan a
 * un documento: un `create`/`join` cuyo `reserve` falla no persiste nada, y
 * una sala guardada con apuesta ya la tiene `ACTIVE`. `PENDING_RESERVE` si
 * vive en el agregado EN MEMORIA mientras la aplicacion llama a Wallet, y es
 * el estado del que parte `withStakesActivated()`.
 */
export const StakeStatus = {
  PendingReserve: 'PENDING_RESERVE',
  Active: 'ACTIVE',
  ReserveFailed: 'RESERVE_FAILED',
  Released: 'RELEASED',
  Captured: 'CAPTURED',
  SettledWon: 'SETTLED_WON',
} as const

export type StakeStatus = (typeof StakeStatus)[keyof typeof StakeStatus]

const ALL_STATUSES: readonly StakeStatus[] = [
  StakeStatus.PendingReserve,
  StakeStatus.Active,
  StakeStatus.ReserveFailed,
  StakeStatus.Released,
  StakeStatus.Captured,
  StakeStatus.SettledWon,
]

export interface ParticipantStake {
  /** Entero >= 1; `0`/ausente significa "no aposto". */
  readonly amount: number
  /** `operationId` de la reserva en Wallet (determinista: `battle:{id}:player:{id}:stake:reserve`). */
  readonly holdOperationId: string
  readonly status: StakeStatus
}

/**
 * Alta de una apuesta.
 *
 * `holdOperationId` es OPCIONAL en la entrada porque el cliente solo declara
 * el monto: lo resuelve la aplicacion con `stakeReserveOperationIdOf` ANTES de
 * construir el agregado (es determinista y no puede venir del cliente). Al
 * restaurar de persistencia viajan el `holdOperationId` y el `status`
 * guardados.
 */
export interface ParticipantStakeInput {
  readonly amount: number
  readonly holdOperationId?: string
  readonly status?: StakeStatus
}

/**
 * Apuesta con la posicion del participante, para las politicas y los
 * servicios que no conocen el agregado (reparto, liquidacion, liberacion).
 */
export interface StakeAtRisk {
  readonly teamLabel: string
  readonly seat: number
  readonly playerId: string
  readonly amount: number
  readonly holdOperationId: string
  readonly status: StakeStatus
}

/**
 * `null` cuando el monto es 0 (D5: `0` = no apostar, no un error) y cuando no
 * hay apuesta declarada. Un monto negativo o no entero es `INVALID_AMOUNT`.
 */
export const createParticipantStake = (input: ParticipantStakeInput): ParticipantStake | null => {
  if (input.amount === 0) {
    return null
  }

  if (!Number.isInteger(input.amount) || input.amount < 1) {
    throw new InvalidStakeAmountError(input.amount)
  }

  const holdOperationId = (input.holdOperationId ?? '').trim()

  if (holdOperationId.length === 0) {
    throw new DomainError(
      'Una apuesta necesita el operationId determinista de su reserva (lo resuelve la aplicacion).',
    )
  }

  const status = input.status ?? StakeStatus.PendingReserve

  if (!ALL_STATUSES.includes(status)) {
    throw new DomainError(`El estado de apuesta "${status}" no es reconocido.`)
  }

  return { amount: input.amount, holdOperationId, status }
}
