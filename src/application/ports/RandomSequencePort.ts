import type { RandomIndex } from '../../domain/value-objects/RandomIndex'
import type { RandomSeed } from '../../domain/value-objects/RandomSeed'

/**
 * Secuencia de INDICES pseudoaleatorios con estado (HU-24, RF-24). Es la
 * UNICA via de consumo funcional del motor: combate (HU-25 y siguientes) y la
 * futura simulacion para Missions solo deben depender de este puerto.
 *
 * Cada llamada AVANZA el estado interno: dos llamadas consecutivas no
 * reinician la semilla ni repiten valores. Una batalla de varios turnos crea
 * UNA secuencia y la consume turno a turno.
 *
 * El estado (MT19937 y la normal pendiente de Box-Muller) es interno y NO se
 * expone: ningun metodo devuelve la semilla ni el estado, de modo que ningun
 * DTO puede filtrarlos a un cliente (ADR-019).
 *
 * A proposito NO ofrece la variable normal: ver `NormalSequencePort`.
 */
export interface RandomSequencePort {
  /**
   * Indice en 1..8000 para la tabla de control (HU-25). Su distribucion la fija
   * la estrategia de mapeo con la que se compuso la fabrica.
   */
  nextIndex(): RandomIndex
}

/**
 * Secuencia de variables normales N(0,1) CRUDAS (etapa Mersenne Twister +
 * Box-Muller, antes del mapeo a indice).
 *
 * SOLO PARA VALIDACION Y DIAGNOSTICO (p. ej. el estudio estadistico de HU-26).
 * La logica de combate NO debe consumirla.
 *
 * Es un objeto INDEPENDIENTE de `RandomSequencePort`, con su propio MT19937
 * sembrado igual: pedir normales aqui jamas desplaza los indices de una
 * `RandomSequencePort` creada con la misma semilla. Ese aislamiento es el
 * motivo de la separacion: si ambos metodos compartieran un mismo cursor, una
 * llamada de depuracion a la normal cambiaria el indice siguiente de la
 * batalla. La normal n-esima de esta secuencia es exactamente el valor a partir
 * del cual se obtiene el indice n-esimo de la secuencia de indices.
 */
export interface NormalSequencePort {
  /** Variable aproximadamente N(0,1) (etapa Mersenne Twister + Box-Muller). */
  nextNormal(): number
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
  /** Secuencia de indices: la que consume la logica de combate. */
  create(seed: RandomSeed): RandomSequencePort

  /**
   * Secuencia normal cruda, independiente de la de indices, solo para
   * validacion/diagnostico. No la use la logica de combate.
   */
  createNormalSequence(seed: RandomSeed): NormalSequencePort
}

export const RANDOM_SEQUENCE_FACTORY = Symbol('RandomSequenceFactoryPort')
