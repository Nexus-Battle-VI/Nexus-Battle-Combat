import type { RandomSequenceFactoryPort } from '../../src/application/ports/RandomSequencePort'
import type { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

/**
 * Muestra del INDICE funcional 1..8000 de una semilla (validacion SECUNDARIA).
 *
 *   factory.create(seed)  ->  nextIndex()  x sampleSize
 *
 * Sirve solo para comprobar que el indice permanece en 1..8000 y es
 * aproximadamente uniforme (coherente con HU-25). NO participa en la seleccion
 * de la semilla y NO sustituye KS / Ljung-Box / Q-Q de la normal: eso se valida
 * unicamente con `generateNormalSample` (`createNormalSequence`).
 */
export const generateIndexSample = (
  factory: RandomSequenceFactoryPort,
  seed: RandomSeed,
  sampleSize: number,
): Uint16Array => {
  const sequence = factory.create(seed)
  const sample = new Uint16Array(sampleSize)

  for (let position = 0; position < sampleSize; position += 1) {
    // 1..8000 cabe en uint16.
    sample[position] = sequence.nextIndex().value
  }

  return sample
}
