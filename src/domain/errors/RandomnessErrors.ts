import { DomainError } from './DomainError'

/**
 * Errores de invariantes del motor pseudoaleatorio (HU-24, RF-24).
 *
 * Viven en el DOMINIO por el mismo criterio que `BattleRoomErrors.ts`: cada uno
 * se determina por completo con el valor recibido, sin infraestructura ni E/S.
 * Son errores de PROGRAMACION del servidor (ningun cliente aporta semilla ni
 * indice), asi que no tienen traduccion HTTP: si alguno se propagara hasta un
 * controlador seria un defecto y debe salir como 500, no como 4xx.
 */

/**
 * El valor no es un indice valido de la tabla de control de 8000 filas
 * (RF-25/HU-25): debe ser un entero en 1..8000. Rechaza 0, 8001, decimales,
 * `NaN` e `Infinity`.
 */
export class InvalidRandomIndexError extends DomainError {
  constructor(raw: unknown) {
    super(`El indice aleatorio "${String(raw)}" no es un entero entre 1 y 8000.`)
    this.name = 'InvalidRandomIndexError'
  }
}

/**
 * La semilla no es un entero sin signo de 32 bits (0..4294967295), que es el
 * dominio de la inicializacion canonica `init_genrand` de MT19937.
 */
export class InvalidRandomSeedError extends DomainError {
  constructor(raw: unknown) {
    super(`La semilla "${String(raw)}" no es un entero entre 0 y 4294967295 (uint32).`)
    this.name = 'InvalidRandomSeedError'
  }
}
