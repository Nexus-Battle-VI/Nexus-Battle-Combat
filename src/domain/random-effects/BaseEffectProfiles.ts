import { HeroSubtype } from '../value-objects/HeroSubtype'
import { EFFECT_TABLE_ROWS, EffectControlTable } from './EffectControlTable'
import { RandomEffectType } from './RandomEffectType'

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
 *   Chaman / Medico           0       0        0        0        0       100   (*)
 *
 * (*) SANADORES: el documento imprime 0 % en TODAS las filas de Chaman y Medico
 * (Tabla 21), que no suma 100 %, y a la vez ordena en su nota del proyecto
 * (tras la Tabla 23) «disenar las tablas de efectos aleatorios para todos los
 * personajes, manteniendo la logica del ejercicio [...] y evitando un
 * desequilibrio». Decision de diseno ADOPTADA por instruccion del PO/profesor de
 * resolver los pendientes con el documento: `no causar dano` = 100 %. Es la UNICA
 * distribucion que respeta todo lo que el documento dice de ellos: 0 % en los
 * cinco efectos que danan (Tabla 21), sin Ataque ni Dano (Tabla 6: «-») y con
 * «no causar dano» como el efecto residual que absorbe lo que los demas no ocupan
 * (Tabla 23). No introduce ningun valor de balance: un sanador no gana capacidad
 * ofensiva que el documento le niega.
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
      noDamage: 100,
    }),
    [HeroSubtype.Medico]: profile({
      damage: 0,
      criticalDamage: 0,
      evade: 0,
      resist: 0,
      escape: 0,
      noDamage: 100,
    }),
  })

/**
 * Tabla de control base del tipo de heroe (filas = porcentaje x 80).
 *
 * Cada perfil suma 100 %; si alguno dejara de hacerlo, `EffectControlTable`
 * rechaza la distribucion (`IncompleteEffectDistributionError`) en lugar de
 * completarla o recortarla.
 */
export const baseEffectTableFor = (subtype: HeroSubtype): EffectControlTable => {
  const configured = BASE_EFFECT_PERCENTAGES[subtype]

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
