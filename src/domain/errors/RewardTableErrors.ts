import { DomainError } from './DomainError'

/**
 * Errores de invariantes de la reward table del cofre (HU-22).
 *
 * Mismo criterio que `RandomEffectErrors.ts`: se determinan por completo con
 * los datos de configuracion, sin infraestructura ni E/S. Son errores de
 * CONFIGURACION del servidor (la reward table es un artefacto versionado que
 * Combat embebe, ningun cliente la aporta): si alguno llegara a producirse en
 * produccion seria un defecto del archivo de configuracion, no una entrada de
 * usuario invalida.
 */

/** Los tramos no cubren exactamente 1..8000, sin huecos ni solapes. */
export class InvalidRewardTableError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRewardTableError'
  }
}
