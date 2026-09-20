import { UnsupportedHeroEffectProfileError } from '../errors/RandomEffectErrors'
import { HeroSubtype } from '../value-objects/HeroSubtype'
import { EFFECT_TABLE_ROWS, EffectControlTable } from './EffectControlTable'
import { RANDOM_EFFECT_ORDER, RandomEffectType } from './RandomEffectType'

/** Porcentaje entero de cada efecto (Tabla 21). */
export type EffectPercentages = Readonly<Record<RandomEffectType, number>>

/** 8000 filas = 100 %, luego 1 punto porcentual = 80 filas. */
export const ROWS_PER_PERCENT = EFFECT_TABLE_ROWS / 100

/**
 * Porcentajes de un perfil con NOMBRE, no por posicion: intercambiar `evade` y
 * `resist` (o cualquier otro par) es visible en la lectura y en la revision.
 */
interface EffectProfileDefinition {
  readonly damage: number
  readonly criticalDamage: number
  readonly evade: number
  readonly resist: number
  readonly escape: number
  readonly noDamage: number
}

const profile = (definition: EffectProfileDefinition): EffectPercentages =>
  Object.freeze({
    [RandomEffectType.Damage]: definition.damage,
    [RandomEffectType.CriticalDamage]: definition.criticalDamage,
    [RandomEffectType.Evade]: definition.evade,
    [RandomEffectType.Resist]: definition.resist,
    [RandomEffectType.Escape]: definition.escape,
    [RandomEffectType.NoDamage]: definition.noDamage,
  })

/**
 * Configuracion BASE de efectos por tipo de heroe: la Tabla 21 del documento
 * oficial "Proyecto Integrador II" (seccion 6.1.4), transcrita SIN cambios. Es
 * la unica fuente de estos valores; las pruebas la contrastan con las tablas 22
 * y 23 y con los rangos derivados. "Configuracion base sin equipamiento, items
 * o epicas".
 *
 *                          Causar  Critico  Evaden  Resisten  Escapan  No causar
 *   Guerrero Tanque          40       0        5        0        5        50
 *   Guerrero Armas           60       5        3        0        2        30
 *   Mago Fuego               70       5        0        5        0        20
 *   Mago Hielo               70       6        0        4        0        20
 *   Picaro Veneno            55      10        0        0        0        35
 *   Picaro Machete           60       8        0        0        2        30
 *   Chaman / Medico           0       0        0        0        0         0
 *
 * CHAMAN Y MEDICO se transcriben tal cual (0 % en todo) y NO se completan: esa
 * fila suma 0 % y no 100 %, asi que el documento no entrega una distribucion
 * valida para ellos. `baseEffectTableFor` lo rechaza de forma explicita.
 */
export const BASE_EFFECT_PERCENTAGES: Readonly<Record<HeroSubtype, EffectPercentages>> =
  Object.freeze({
    [HeroSubtype.GuerreroTanque]: profile({
      damage: 40,
      criticalDamage: 0,
      evade: 5,
      resist: 0,
      escape: 5,
      noDamage: 50,
    }),
    [HeroSubtype.GuerreroArmas]: profile({
      damage: 60,
      criticalDamage: 5,
      evade: 3,
      resist: 0,
      escape: 2,
      noDamage: 30,
    }),
    [HeroSubtype.MagoFuego]: profile({
      damage: 70,
      criticalDamage: 5,
      evade: 0,
      resist: 5,
      escape: 0,
      noDamage: 20,
    }),
    [HeroSubtype.MagoHielo]: profile({
      damage: 70,
      criticalDamage: 6,
      evade: 0,
      resist: 4,
      escape: 0,
      noDamage: 20,
    }),
    [HeroSubtype.PicaroVeneno]: profile({
      damage: 55,
      criticalDamage: 10,
      evade: 0,
      resist: 0,
      escape: 0,
      noDamage: 35,
    }),
    [HeroSubtype.PicaroMachete]: profile({
      damage: 60,
      criticalDamage: 8,
      evade: 0,
      resist: 0,
      escape: 2,
      noDamage: 30,
    }),
    [HeroSubtype.Chaman]: profile({
      damage: 0,
      criticalDamage: 0,
      evade: 0,
      resist: 0,
      escape: 0,
      noDamage: 0,
    }),
    [HeroSubtype.Medico]: profile({
      damage: 0,
      criticalDamage: 0,
      evade: 0,
      resist: 0,
      escape: 0,
      noDamage: 0,
    }),
  })

/**
 * Tabla de control base del tipo de heroe (filas = porcentaje x 80).
 *
 * Lanza `UnsupportedHeroEffectProfileError` si el documento no define una
 * distribucion de 100 % para ese tipo (hoy: Chaman y Medico). No construye una
 * tabla de "8000 x no causar dano", no reparte porcentajes ni copia otra clase.
 */
export const baseEffectTableFor = (subtype: HeroSubtype): EffectControlTable => {
  const configured = BASE_EFFECT_PERCENTAGES[subtype]
  const total = RANDOM_EFFECT_ORDER.reduce((sum, effect) => sum + configured[effect], 0)

  if (total !== 100) {
    throw new UnsupportedHeroEffectProfileError(
      subtype,
      `el documento oficial (Tabla 21) declara ${String(total)} % en total y no 100 %; no se inventa una distribucion.`,
    )
  }

  return EffectControlTable.fromRowCounts({
    [RandomEffectType.Damage]: configured[RandomEffectType.Damage] * ROWS_PER_PERCENT,
    [RandomEffectType.CriticalDamage]:
      configured[RandomEffectType.CriticalDamage] * ROWS_PER_PERCENT,
    [RandomEffectType.Evade]: configured[RandomEffectType.Evade] * ROWS_PER_PERCENT,
    [RandomEffectType.Resist]: configured[RandomEffectType.Resist] * ROWS_PER_PERCENT,
    [RandomEffectType.Escape]: configured[RandomEffectType.Escape] * ROWS_PER_PERCENT,
    [RandomEffectType.NoDamage]: configured[RandomEffectType.NoDamage] * ROWS_PER_PERCENT,
  })
}
