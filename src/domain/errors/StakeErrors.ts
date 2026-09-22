import { DomainError } from './DomainError'

/**
 * Errores de la apuesta de creditos (HU-23, contrato
 * `hu-23-battle-stake-v1` §11). Ambos son reglas de negocio incumplidas
 * (422 en el controlador, con su `code`), no datos malformados.
 */

/** El monto no es un entero >= 1 (`amount: 0` significa "no apostar", no un error). */
export class InvalidStakeAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT'

  constructor(amount: number) {
    super(`El monto de la apuesta debe ser un entero >= 1: ${String(amount)}.`)
    this.name = 'InvalidStakeAmountError'
  }
}

/** Se intento apostar en una sala PVE (D4): Combat ni siquiera llama a Wallet. */
export class StakeNotAllowedInPveError extends DomainError {
  readonly code = 'STAKE_NOT_ALLOWED_IN_PVE'

  constructor() {
    super('Las salas PVE no admiten apuesta de creditos.')
    this.name = 'StakeNotAllowedInPveError'
  }
}
