import type { RandomIndex } from '../../../domain/value-objects/RandomIndex'

/**
 * Contratos INTERNOS de las etapas del motor pseudoaleatorio (HU-24).
 *
 * Existen para que cada etapa dependa de una interfaz y no de la anterior:
 *
 *   UniformSource  ->  NormalSource  ->  NormalToIndexMapper
 *   (Mersenne Twister)  (Box-Muller)     (estrategia de mapeo)
 *
 * Asi se puede sustituir la ULTIMA etapa (si el PO/profesor formaliza otra
 * interpretacion de RF-24 vs RF-25) sin reescribir ni volver a probar MT19937
 * ni Box-Muller. No son puertos de aplicacion: la aplicacion solo conoce
 * `RandomSequencePort`.
 */

/** Fuente de uniformes en [0, 1) con 53 bits de resolucion. */
export interface UniformSource {
  nextDouble(): number
}

/** Fuente de variables aproximadamente N(0, 1). */
export interface NormalSource {
  nextNormal(): number
}

/**
 * Convierte una variable normal estandar en un indice de la tabla de control.
 * Es LA decision tecnica provisional de HU-24 (ver docs/hu-24-randomness-engine.md).
 */
export interface NormalToIndexMapper {
  map(normal: number): RandomIndex
}
