import type {
  RandomSequenceFactoryPort,
  RandomSequencePort,
} from '../../../application/ports/RandomSequencePort'
import type { RandomIndex } from '../../../domain/value-objects/RandomIndex'
import type { RandomSeed } from '../../../domain/value-objects/RandomSeed'
import { BoxMullerNormalGenerator } from './BoxMullerNormalGenerator'
import { Mt19937 } from './Mt19937'
import type { NormalSource, NormalToIndexMapper } from './RandomnessContracts'

/**
 * Secuencia concreta: Mersenne Twister -> Box-Muller -> mapper.
 *
 * Toda la cadena de estado (los 624 uint32 de MT, la normal pendiente de
 * Box-Muller) vive en los objetos que esta clase posee y es invisible desde
 * fuera: los campos son privados de ECMAScript, sin getters ni `toJSON`.
 */
class Mt19937BoxMullerRandomSequence implements RandomSequencePort {
  readonly #normals: NormalSource
  readonly #mapper: NormalToIndexMapper

  constructor(normals: NormalSource, mapper: NormalToIndexMapper) {
    this.#normals = normals
    this.#mapper = mapper
  }

  nextNormal(): number {
    return this.#normals.nextNormal()
  }

  nextIndex(): RandomIndex {
    return this.#mapper.map(this.#normals.nextNormal())
  }
}

/**
 * Fabrica de secuencias de Combat (HU-24, RF-24). Cada `create(seed)` devuelve
 * una secuencia INDEPENDIENTE con su propio MT19937: no hay cursor global
 * compartido entre batallas, y la misma semilla reproduce exactamente la misma
 * secuencia dentro de esta implementacion.
 *
 * El mapper se inyecta (sin valor por defecto) para que la composicion, en
 * `infrastructure/bootstrap`, sea el unico lugar donde se decide la estrategia
 * normal -> indice.
 */
export class Mt19937BoxMullerRandomSequenceFactory implements RandomSequenceFactoryPort {
  readonly #mapper: NormalToIndexMapper

  constructor(mapper: NormalToIndexMapper) {
    this.#mapper = mapper
  }

  create(seed: RandomSeed): RandomSequencePort {
    return new Mt19937BoxMullerRandomSequence(
      new BoxMullerNormalGenerator(new Mt19937(seed)),
      this.#mapper,
    )
  }
}
