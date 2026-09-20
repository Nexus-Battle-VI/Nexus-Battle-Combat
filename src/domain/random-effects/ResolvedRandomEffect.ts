import type { EffectMagnitude } from './EffectMagnitude'
import type { RandomEffectType } from './RandomEffectType'

/**
 * Resultado de resolver un indice contra una tabla de control (HU-25, CA-08):
 * el efecto aplicado y su magnitud RELATIVA segun la tabla vigente.
 *
 * Es exactamente lo que HU-25 conoce. No trae dano numerico, vida ni ninguna
 * decision posterior: eso lo calculara el motor de combate (HU-20) a partir de
 * este resultado. Tampoco trae el indice, la fila ni la semilla: son datos del
 * servidor que no deben salir de el.
 */
export interface ResolvedRandomEffect {
  readonly effect: RandomEffectType
  readonly magnitude: EffectMagnitude
}
