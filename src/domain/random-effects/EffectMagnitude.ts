import { RandomEffectType } from './RandomEffectType'

/**
 * Magnitud RELATIVA de un efecto: lo unico que HU-25 conoce del dano.
 *
 * El dano numerico final depende de otros datos (valor de ataque, defensa,
 * vida...) y de reglas posteriores que pertenecen a HU-20/HU-18. HU-25 no
 * inventa esa formula: solo devuelve el porcentaje que el documento asocia a
 * cada efecto.
 *
 * - `FIXED_PERCENT`: un porcentaje concreto del dano (Tabla 22, "Efecto
 *   esperado").
 * - `PERCENT_RANGE`: un intervalo [min, max]. Solo lo usa el critico
 *   ("entre un [120 % a 180 %]"). El documento solo define el intervalo, no como
 *   escoger un valor concreto dentro de el; ver `materializePercent` para la
 *   regla adoptada (no usa un segundo indice ni ningun otro generador).
 */
export type EffectMagnitude =
  | { readonly kind: 'FIXED_PERCENT'; readonly percent: number }
  | { readonly kind: 'PERCENT_RANGE'; readonly minPercent: number; readonly maxPercent: number }

/**
 * Magnitudes oficiales (Tabla 22, columna "Efecto esperado"). Se conservan
 * EXACTAMENTE como estan en el documento aunque los nombres de "Evaden" o
 * "Escapan" parezcan extranos junto a 80 % o 20 % de dano: no se corrigen.
 */
export const EFFECT_MAGNITUDES: Readonly<Record<RandomEffectType, EffectMagnitude>> = Object.freeze(
  {
    [RandomEffectType.Damage]: Object.freeze({ kind: 'FIXED_PERCENT', percent: 100 } as const),
    [RandomEffectType.CriticalDamage]: Object.freeze({
      kind: 'PERCENT_RANGE',
      minPercent: 120,
      maxPercent: 180,
    } as const),
    [RandomEffectType.Evade]: Object.freeze({ kind: 'FIXED_PERCENT', percent: 80 } as const),
    [RandomEffectType.Resist]: Object.freeze({ kind: 'FIXED_PERCENT', percent: 60 } as const),
    [RandomEffectType.Escape]: Object.freeze({ kind: 'FIXED_PERCENT', percent: 20 } as const),
    [RandomEffectType.NoDamage]: Object.freeze({ kind: 'FIXED_PERCENT', percent: 0 } as const),
  },
)

/**
 * Porcentaje CONCRETO de dano de una fila (HU-25, pendiente «critico 120-180»).
 *
 * El documento oficial (Tablas 22 y 23) asigna al critico «entre un [120 % a
 * 180 %] de dano» y describe cada fila de la tabla como uno de los «posibles
 * valores para el indice aleatorio» (880 en la Tabla 23), pero NO dice como se
 * escoge el porcentaje dentro del intervalo. DECISION DE DISENO adoptada por
 * instruccion del PO/profesor de resolver los pendientes con el documento:
 *
 *   el intervalo se reparte en tramos iguales sobre las filas contiguas del
 *   efecto, de modo que la POSICION de la fila seleccionada determina el
 *   porcentaje entero:  min + floor(posicion x valores / filas)
 *
 * donde `valores = max - min + 1` (61 porcentajes enteros, 120..180) y
 * `posicion` cuenta desde 0 dentro del rango del efecto. Es una funcion pura del
 * MISMO indice que ya selecciono el efecto: no consume un segundo indice, no usa
 * otra fuente de aleatoriedad (RF-25, CA-07) y, como el indice es uniforme, cada
 * porcentaje recibe el mismo numero de filas salvo la diferencia de una fila que
 * impone dividir en enteros. Cambiar esta regla es cambiar SOLO esta funcion.
 *
 * Un efecto de magnitud fija devuelve su porcentaje sin mirar la posicion.
 */
export const materializePercent = (
  magnitude: EffectMagnitude,
  rowOffset: number,
  rowCount: number,
): number => {
  if (magnitude.kind === 'FIXED_PERCENT') {
    return magnitude.percent
  }

  const values = magnitude.maxPercent - magnitude.minPercent + 1

  return magnitude.minPercent + Math.floor((rowOffset * values) / rowCount)
}
