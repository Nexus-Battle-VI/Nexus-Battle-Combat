import { InvalidRandomIndexError } from '../errors/RandomnessErrors'

/**
 * Indice de la tabla de control de 8000 filas (HU-24, RF-24; consumido por
 * HU-25).
 *
 * Garantiza POR CONSTRUCCION `1 <= value <= 8000` y `Number.isInteger(value)`:
 * el constructor es privado y `create()` rechaza `0`, `8001`, decimales, `NaN`
 * e `Infinity`. Quien consuma un `RandomIndex` no necesita volver a validarlo.
 *
 * Este objeto de valor NO decide COMO se obtiene el indice (eso es la
 * estrategia de mapeo, intercambiable): solo impide que exista uno invalido.
 * Tampoco es una semilla: la semilla inicializa el generador, el indice es una
 * salida de la secuencia.
 */
export class RandomIndex {
  /** Primera fila de la tabla de control. */
  static readonly MIN = 1
  /** Ultima fila de la tabla de control (la tabla tiene 8000 filas). */
  static readonly MAX = 8000

  readonly value: number

  private constructor(value: number) {
    this.value = value
  }

  static create(raw: unknown): RandomIndex {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < RandomIndex.MIN ||
      raw > RandomIndex.MAX
    ) {
      throw new InvalidRandomIndexError(raw)
    }

    return new RandomIndex(raw)
  }

  equals(other: RandomIndex): boolean {
    return this.value === other.value
  }

  toString(): string {
    return String(this.value)
  }
}
