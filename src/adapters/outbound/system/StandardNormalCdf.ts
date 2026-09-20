/**
 * Funcion de distribucion acumulada de la normal estandar, Phi(z) (HU-24).
 *
 * `Math.erf` no existe en JavaScript, y traer una libreria cientifica solo por
 * una CDF seria desproporcionado. Se implementa la aproximacion racional de
 * Hart (1968) en la formulacion de Graeme West ("Better approximations to
 * cumulative normal functions", Wilmott, 2005). Precision MEDIDA contra
 * `scipy.special.ndtr` en la rejilla z in [-9, 9] con paso 0,01 (1801 puntos):
 * error absoluto maximo 2,2e-16 y error relativo en la cola inferior (z <= -1)
 * de hasta ~9e-9. Al mapeo a 8000 filas solo le importa el error ABSOLUTO (debe
 * ser mucho menor que 1/8000 = 1,25e-4), que queda ~12 ordenes de magnitud por
 * debajo. Las aproximaciones de Abramowitz-Stegun (error ~1e-7) tambien
 * bastarian para eso, pero degradan las colas; esta no.
 *
 * Es una funcion de UTILIDAD numerica pura: sin estado, sin E/S, sin reloj.
 *
 * Propiedades que se prueban: Phi(0) = 0,5; Phi(-z) = 1 - Phi(z) (por
 * construccion); resultado siempre en [0, 1]; Phi(+-Infinity) = 1 / 0; casi
 * monotona (una aproximacion por tramos puede tener saltos de 1 ULP en la
 * frontera entre tramos, irrelevantes para el mapeo a 8000 filas).
 */

/** |z| a partir del cual la cola es menor que la resolucion de un `double`. */
const TAIL_CUTOFF = 37
/** Frontera entre la aproximacion racional y la fraccion continua de la cola. */
const RATIONAL_LIMIT = 7.071_067_811_865_47
const SQRT_2_PI = 2.506_628_274_631

export const standardNormalCdf = (z: number): number => {
  if (Number.isNaN(z)) {
    throw new RangeError('La CDF normal no esta definida para NaN.')
  }

  const abs = Math.abs(z)
  let lowerTail: number

  if (abs > TAIL_CUTOFF) {
    lowerTail = 0
  } else {
    const exponential = Math.exp((-abs * abs) / 2)

    if (abs < RATIONAL_LIMIT) {
      let numerator = 3.526_249_659_989_11e-2 * abs + 0.700_383_064_443_688
      numerator = numerator * abs + 6.373_962_203_531_65
      numerator = numerator * abs + 33.912_866_078_383
      numerator = numerator * abs + 112.079_291_497_871
      numerator = numerator * abs + 221.213_596_169_931
      numerator = numerator * abs + 220.206_867_912_376

      let denominator = 8.838_834_764_831_84e-2 * abs + 1.755_667_163_182_64
      denominator = denominator * abs + 16.064_177_579_207
      denominator = denominator * abs + 86.780_732_202_946_1
      denominator = denominator * abs + 296.564_248_779_674
      denominator = denominator * abs + 637.333_633_378_831
      denominator = denominator * abs + 793.826_512_519_948
      denominator = denominator * abs + 440.413_735_824_752

      lowerTail = (exponential * numerator) / denominator
    } else {
      let continued = abs + 0.65
      continued = abs + 4 / continued
      continued = abs + 3 / continued
      continued = abs + 2 / continued
      continued = abs + 1 / continued

      lowerTail = exponential / continued / SQRT_2_PI
    }
  }

  const cdf = z > 0 ? 1 - lowerTail : lowerTail

  // Frontera de seguridad: ningun error de redondeo puede sacar la salida de [0, 1].
  return Math.min(1, Math.max(0, cdf))
}
