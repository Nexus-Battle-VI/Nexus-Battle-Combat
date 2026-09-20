import type { RandomIndex } from '../../domain/value-objects/RandomIndex'
import type { RandomSeed } from '../../domain/value-objects/RandomSeed'

/**
 * Secuencia pseudoaleatoria CON ESTADO (HU-24, RF-24).
 *
 * Cada llamada AVANZA el estado interno: dos llamadas consecutivas no
 * reinician la semilla ni repiten valores. Una batalla de varios turnos crea
 * UNA secuencia y la consume turno a turno.
 *
 * El estado (MT19937 y la normal pendiente de Box-Muller) es interno y NO se
 * expone: ningun metodo devuelve la semilla ni el estado, de modo que ningun
 * DTO puede filtrarlos a un cliente (ADR-019).
 *
 * `nextNormal()` y `nextIndex()` consumen la MISMA secuencia: llamar a una
 * avanza tambien a la otra.
 */
export interface RandomSequencePort {
  /** Variable aproximadamente N(0,1) (etapa Mersenne Twister + Box-Muller). */
  nextNormal(): number

  /**
   * Indice en 1..8000 para la tabla de control (HU-25). Su distribucion la fija
   * la estrategia de mapeo con la que se compuso la fabrica.
   */
  nextIndex(): RandomIndex
}

/**
 * Fabrica de secuencias. La semilla se entrega al CREAR la secuencia, nunca por
 * llamada: eso es lo que impide reiniciarla por accidente.
 *
 * Es una fabrica y no un singleton a proposito. "Centralizado" significa una
 * unica autoridad y una unica implementacion en Combat, no que todas las
 * batallas compartan un cursor global: cada batalla o simulacion crea la suya y
 * puede reproducirse por separado.
 */
export interface RandomSequenceFactoryPort {
  create(seed: RandomSeed): RandomSequencePort
}

export const RANDOM_SEQUENCE_FACTORY = Symbol('RandomSequenceFactoryPort')
