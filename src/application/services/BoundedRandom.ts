import { RandomSelectionExhaustedError } from '../../domain/errors/BattleErrors'
import type { BoundedRandom } from '../../domain/policies/TurnOrderPolicy'
import { RandomIndex } from '../../domain/value-objects/RandomIndex'
import type { RandomSequencePort } from '../ports/RandomSequencePort'

/** Filas de la tabla de control de HU-24/HU-25. */
const ROWS = RandomIndex.MAX

/** Tope de intentos del muestreo por rechazo: el bucle nunca es infinito. */
const MAX_ATTEMPTS = 64

/**
 * Entero uniforme en `[0, bound)` construido sobre la UNICA fuente aleatoria de
 * Combat (`RandomSequencePort.nextIndex()`, HU-24), sin sesgo de modulo.
 *
 * `nextIndex()` es uniforme en `1..8000`. Con `v = indice - 1` (uniforme en
 * `0..7999`), `v mod bound` NO es uniforme cuando 8000 no es multiplo de
 * `bound` (p. ej. 3, 5, 6, 7): los residuos bajos tendrian una fila mas. El
 * muestreo por rechazo lo evita: se acepta `v` solo si `v < 8000 - (8000 mod
 * bound)` (el mayor multiplo de `bound` que cabe) y en otro caso se descarta y
 * se toma otro indice. Con `bound` 1 no se consume ningun indice; con `bound`
 * 2, 4, 5, 8... divisor de 8000 nunca se rechaza. El rechazo maximo para los
 * valores de HU-17 (`bound` <= 6) es 2/8000 = 0,025 % por intento.
 *
 * No usa `Math.random`, `crypto`, `Date.now` ni otro generador: cada
 * seleccion consume 1 indice de la secuencia (mas 1 por cada rechazo).
 */
export const createBoundedRandom = (sequence: RandomSequencePort): BoundedRandom => ({
  nextInt: (bound: number): number => {
    if (!Number.isInteger(bound) || bound < 1 || bound > ROWS) {
      throw new RangeError(`bound debe ser un entero entre 1 y ${String(ROWS)}.`)
    }

    if (bound === 1) {
      return 0
    }

    const limit = ROWS - (ROWS % bound)

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const value = sequence.nextIndex().value - 1

      if (value < limit) {
        return value % bound
      }
    }

    throw new RandomSelectionExhaustedError(bound)
  },
})
