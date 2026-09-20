import { InvalidRandomSeedError } from '../errors/RandomnessErrors'

/**
 * Semilla de una secuencia pseudoaleatoria (HU-24).
 *
 * DECISION TECNICA (no requisito funcional): entero sin signo de 32 bits, que
 * es el dominio de la inicializacion canonica `init_genrand(s)` del MT19937 de
 * referencia (Matsumoto y Nishimura). RF-24 no define el rango de la semilla.
 *
 * La semilla NO es un indice de juego: `3_000_000` no significa "fila
 * 3.000.000", significa "inicializa MT19937 con este valor". La politica de
 * QUE semilla recibe cada batalla o simulacion pertenece a la integracion
 * posterior (HU-26) y no se decide aqui.
 *
 * Es un dato SOLO del servidor: no se serializa a ningun cliente mientras la
 * batalla o simulacion este abierta (ADR-019).
 */
export class RandomSeed {
  static readonly MAX = 0xffff_ffff

  readonly value: number

  private constructor(value: number) {
    this.value = value
  }

  static create(raw: unknown): RandomSeed {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > RandomSeed.MAX) {
      throw new InvalidRandomSeedError(raw)
    }

    return new RandomSeed(raw)
  }
}
