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
 *   ("entre un [120 % a 180 %]"). El documento NO define como escoger un valor
 *   concreto dentro del intervalo (ni distribucion, ni entero o decimal, ni
 *   fuente aleatoria), asi que HU-25 NO lo materializa: entrega el rango tal
 *   cual y no consume un segundo indice ni ningun otro generador. Queda como
 *   pendiente funcional (ver `docs/hu-25-effect-control-table.md`).
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
