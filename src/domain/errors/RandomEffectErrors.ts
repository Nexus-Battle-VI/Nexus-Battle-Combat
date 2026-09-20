import { DomainError } from './DomainError'

/**
 * Errores de invariantes de la tabla de control de efectos aleatorios (HU-25,
 * RF-25).
 *
 * Viven en el DOMINIO por el mismo criterio que `BattleRoomErrors.ts` y
 * `RandomnessErrors.ts`: cada uno se determina por completo con los datos
 * recibidos, sin infraestructura ni E/S. Son errores de CONFIGURACION o de
 * PROGRAMACION del servidor (ningun cliente aporta filas, porcentajes ni
 * modificadores), asi que no tienen traduccion HTTP: HU-25 no expone ningun
 * endpoint y, si alguno llegara a un controlador, seria un defecto.
 */

/**
 * Las filas asignadas a un efecto no son un entero no negativo, o falta un
 * efecto de la lista oficial. La tabla no puede construirse.
 */
export class InvalidEffectTableError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEffectTableError'
  }
}

/**
 * Las filas asignadas suman algo distinto de 8000: la distribucion no cubre
 * exactamente la tabla (RF-25: "cada tabla de control debe contener ocho mil
 * filas"). No se rellena ni se recorta en silencio.
 */
export class IncompleteEffectDistributionError extends DomainError {
  constructor(totalRows: number) {
    super(
      `La distribucion de efectos suma ${String(totalRows)} filas y debe sumar exactamente 8000.`,
    )
    this.name = 'IncompleteEffectDistributionError'
  }
}

/**
 * El documento oficial no entrega para este tipo de heroe una distribucion
 * valida de 8000 filas (Chaman y Medico: la Tabla 21 da 0 % en todos los
 * efectos, que suma 0 % y no 100 %). No se inventa ninguna distribucion.
 */
export class UnsupportedHeroEffectProfileError extends DomainError {
  constructor(subtype: string, reason: string) {
    super(`El tipo de heroe "${subtype}" no tiene tabla de efectos aleatorios: ${reason}`)
    this.name = 'UnsupportedHeroEffectProfileError'
  }
}

/**
 * El modificador de probabilidad no es aplicable tal como esta definido:
 * efecto desconocido, `NO_DAMAGE` como objetivo (no hay regla de compensacion
 * para el), cantidad negativa o no entera, o una cantidad de puntos basicos que
 * no equivale a un numero exacto de filas. HU-25 solo define incrementos
 * compensados desde "no causar dano"; no se inventan otras semanticas.
 */
export class InvalidProbabilityModifierError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidProbabilityModifierError'
  }
}

/**
 * El incremento pedido supera la probabilidad disponible en "no causar dano"
 * (RF-25: todo aumento se resta de ese efecto). Producir la tabla dejaria filas
 * negativas, asi que se rechaza en lugar de recortar.
 */
export class InsufficientNoDamageProbabilityError extends DomainError {
  constructor(requestedRows: number, availableRows: number) {
    super(
      `El modificador necesita ${String(requestedRows)} filas de "no causar dano" y solo hay ${String(availableRows)}.`,
    )
    this.name = 'InsufficientNoDamageProbabilityError'
  }
}
