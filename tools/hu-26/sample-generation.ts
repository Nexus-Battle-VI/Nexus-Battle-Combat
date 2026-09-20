import type { RandomSequenceFactoryPort } from '../../src/application/ports/RandomSequencePort'
import type { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

/**
 * Muestra de la variable NORMAL cruda Z de una semilla, generada por el codigo
 * PRODUCTIVO de HU-24.
 *
 *   factory.createNormalSequence(seed)  ->  nextNormal()  x sampleSize
 *
 * Es la unica fuente de las pruebas de normalidad de HU-26 (media, desviacion,
 * asimetria, curtosis, Kolmogorov-Smirnov, Ljung-Box y Q-Q). NO usa
 * `create(seed).nextIndex()`: el indice 1..8000 es uniforme por decision tecnica
 * y no debe fingirse normal. La fabrica se recibe por parametro; este modulo no
 * conoce MT19937, Box-Muller ni la CDF y no reimplementa nada del generador.
 */
export const generateNormalSample = (
  factory: RandomSequenceFactoryPort,
  seed: RandomSeed,
  sampleSize: number,
): Float64Array => {
  const sequence = factory.createNormalSequence(seed)
  const sample = new Float64Array(sampleSize)

  for (let position = 0; position < sampleSize; position += 1) {
    sample[position] = sequence.nextNormal()
  }

  return sample
}
