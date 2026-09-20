/**
 * Efectos aleatorios de un golpe efectivo (RF-25, Tabla 21).
 *
 * Terminologia en ingles en el codigo; la documentacion usa los nombres del
 * documento oficial ("Causar dano", "Evaden el golpe", ...).
 *
 * CONGELADO en runtime (`Object.freeze`): `as const` solo protege en tiempo de
 * compilacion, y un valor de esta lista es una regla autoritativa del dominio.
 */
export const RandomEffectType = Object.freeze({
  /** Causar dano. */
  Damage: 'DAMAGE',
  /** Causar dano critico. */
  CriticalDamage: 'CRITICAL_DAMAGE',
  /** Evaden el golpe. */
  Evade: 'EVADE',
  /** Resisten el golpe. */
  Resist: 'RESIST',
  /** Escapan al golpe. */
  Escape: 'ESCAPE',
  /** No causar dano. */
  NoDamage: 'NO_DAMAGE',
} as const)

export type RandomEffectType = (typeof RandomEffectType)[keyof typeof RandomEffectType]

/**
 * ORDEN FIJO de los efectos dentro de la tabla de 8000 filas. Lo confirmo el
 * profesor y coincide con las Tablas 21, 22 y 23: la tabla conserva siempre
 * este orden y cada efecto empieza en la fila siguiente a la ultima del
 * anterior. Un efecto con 0 filas no ocupa ningun rango.
 *
 * CONGELADO en runtime: `readonly` de TypeScript no impide un `reverse()` o un
 * `push()` desde JavaScript, y alterar este orden cambiaria como se construyen
 * TODAS las tablas. Con `Object.freeze` esa mutacion lanza `TypeError`.
 */
export const RANDOM_EFFECT_ORDER = Object.freeze<readonly RandomEffectType[]>([
  RandomEffectType.Damage,
  RandomEffectType.CriticalDamage,
  RandomEffectType.Evade,
  RandomEffectType.Resist,
  RandomEffectType.Escape,
  RandomEffectType.NoDamage,
])

export const isRandomEffectType = (value: unknown): value is RandomEffectType =>
  typeof value === 'string' && (RANDOM_EFFECT_ORDER as readonly string[]).includes(value)
