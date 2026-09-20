import type { RandomSeed } from '../../../domain/value-objects/RandomSeed'
import type { UniformSource } from './RandomnessContracts'

/**
 * Mersenne Twister MT19937 de 32 bits (Matsumoto y Nishimura, 1998), segun el
 * codigo de referencia `mt19937ar.c`. HU-24 / RF-24 lo exigen explicitamente;
 * NO se sustituye por `Math.random()` ni por `crypto`.
 *
 * Implementacion interna, sin dependencias: el algoritmo son ~40 lineas, esta
 * cubierto por vectores de prueba publicados y anadir una libreria no aportaria
 * garantias que estas pruebas no den ya.
 *
 * ATENCION - MT19937 NO es criptograficamente seguro: su estado interno (624
 * palabras) se reconstruye a partir de 624 salidas consecutivas. Por eso el
 * estado y la semilla son EXCLUSIVAMENTE del servidor (ADR-019): ninguna salida
 * cruda debe permitir a un cliente predecir la siguiente.
 *
 * Toda la aritmetica es uint32: en JavaScript los operadores de bits trabajan
 * con enteros de 32 bits CON signo, asi que cada resultado se normaliza con
 * `>>> 0` y la multiplicacion usa `Math.imul` (una multiplicacion normal
 * perderia bits por encima de 2^53).
 *
 * Los campos son privados de ECMAScript (`#`): no son enumerables, de modo que
 * `JSON.stringify` o `Object.keys` sobre la instancia no revelan el estado.
 */
const STATE_SIZE = 624
const SHIFT_SIZE = 397
const MATRIX_A = 0x9908_b0df
const UPPER_MASK = 0x8000_0000
const LOWER_MASK = 0x7fff_ffff
const INIT_MULTIPLIER = 1_812_433_253

const TEMPERING_MASK_B = 0x9d2c_5680
const TEMPERING_MASK_C = 0xefc6_0000

/** 2^26 y 2^53: constantes de `genrand_res53` del codigo de referencia. */
const TWO_POW_26 = 67_108_864
const TWO_POW_53 = 9_007_199_254_740_992

export class Mt19937 implements UniformSource {
  /**
   * Las 624 palabras de estado viven en un `DataView`: a diferencia de un
   * `Uint32Array`, `getUint32` devuelve siempre `number` (con
   * `noUncheckedIndexedAccess` un indice de array devuelve `number | undefined`).
   */
  readonly #state = new DataView(new ArrayBuffer(STATE_SIZE * 4))
  #index = STATE_SIZE

  /** Inicializacion canonica `init_genrand(seed)` del codigo de referencia. */
  constructor(seed: RandomSeed) {
    let previous = seed.value >>> 0
    this.#set(0, previous)

    for (let i = 1; i < STATE_SIZE; i += 1) {
      previous = (Math.imul(INIT_MULTIPLIER, previous ^ (previous >>> 30)) + i) >>> 0
      this.#set(i, previous)
    }
  }

  /** Siguiente entero uint32 (`genrand_int32`). AVANZA el estado. */
  nextUint32(): number {
    if (this.#index >= STATE_SIZE) {
      this.#twist()
    }

    let y = this.#get(this.#index)
    this.#index += 1

    // Templado (tempering).
    y ^= y >>> 11
    y ^= (y << 7) & TEMPERING_MASK_B
    y ^= (y << 15) & TEMPERING_MASK_C
    y ^= y >>> 18

    return y >>> 0
  }

  /**
   * Siguiente uniforme en [0, 1) con 53 bits (`genrand_res53`): usa DOS salidas
   * de 32 bits (27 + 26 bits). Es la resolucion que necesita Box-Muller para
   * que `ln(U1)` no se degrade en las colas.
   */
  nextDouble(): number {
    const high = this.nextUint32() >>> 5
    const low = this.nextUint32() >>> 6

    return (high * TWO_POW_26 + low) / TWO_POW_53
  }

  #get(position: number): number {
    return this.#state.getUint32(position * 4)
  }

  #set(position: number, value: number): void {
    this.#state.setUint32(position * 4, value >>> 0)
  }

  /** Regenera las 624 palabras de estado de una vez (generacion del bloque). */
  #twist(): void {
    for (let i = 0; i < STATE_SIZE; i += 1) {
      const upper = this.#get(i) & UPPER_MASK
      const lower = this.#get((i + 1) % STATE_SIZE) & LOWER_MASK
      const mixed = (upper | lower) >>> 0
      const twisted = (mixed >>> 1) ^ ((mixed & 1) === 1 ? MATRIX_A : 0)

      this.#set(i, this.#get((i + SHIFT_SIZE) % STATE_SIZE) ^ twisted)
    }

    this.#index = 0
  }
}
