import type { NormalSource, UniformSource } from './RandomnessContracts'

/**
 * Transformacion de Box-Muller (HU-24 / RF-24, segunda etapa tras MT19937).
 *
 * A partir de dos uniformes independientes U1, U2 en [0, 1):
 *
 *   R  = sqrt(-2 ln U1)
 *   t  = 2 pi U2
 *   Z0 = R cos t
 *   Z1 = R sin t
 *
 * Z0 y Z1 son N(0, 1) independientes. Se APROVECHAN LOS DOS: la primera
 * llamada devuelve Z0 y guarda Z1; la siguiente devuelve Z1 SIN consumir mas
 * uniformes. Por eso el generador tiene estado (`#pending`) y por eso una
 * secuencia no debe reconstruirse entre llamadas.
 *
 * `ln(0)` es `-Infinity`. MT `genrand_res53` puede devolver exactamente 0
 * (probabilidad 2^-53), asi que U1 se protege con `Number.MIN_VALUE` (el menor
 * positivo representable): da un R finito (~38,6) en vez de `Infinity`. U1 nunca
 * llega a 1 porque la fuente es [0, 1).
 *
 * Esta clase NO conoce la fuente concreta (solo `UniformSource`), lo que permite
 * probarla con una fuente determinista y no depende de Mersenne Twister.
 */
export class BoxMullerNormalGenerator implements NormalSource {
  readonly #source: UniformSource
  #pending: number | null = null

  constructor(source: UniformSource) {
    this.#source = source
  }

  nextNormal(): number {
    if (this.#pending !== null) {
      const pending = this.#pending
      this.#pending = null

      return pending
    }

    const u1 = BoxMullerNormalGenerator.#requireUnit(this.#source.nextDouble())
    const u2 = BoxMullerNormalGenerator.#requireUnit(this.#source.nextDouble())

    const radius = Math.sqrt(-2 * Math.log(u1 === 0 ? Number.MIN_VALUE : u1))
    const angle = 2 * Math.PI * u2

    this.#pending = radius * Math.sin(angle)

    return radius * Math.cos(angle)
  }

  /**
   * Una fuente que devolviera `NaN` o algo fuera de [0, 1) produciria `NaN` o
   * `Infinity` aguas abajo sin ningun aviso. Se rechaza en el origen.
   */
  static #requireUnit(value: number): number {
    if (!(value >= 0 && value < 1)) {
      throw new RangeError(`La fuente uniforme devolvio ${String(value)}, fuera de [0, 1).`)
    }

    return value
  }
}
