import { DomainError } from '../errors/DomainError'
import { HeroSubtype } from '../value-objects/HeroSubtype'
import { RandomIndex } from '../value-objects/RandomIndex'

/**
 * Dado de Ataque de un heroe (HU-20, RF-20): la parte «+ 1dN» de la columna
 * «Ataque» de la Tabla 6 del documento oficial «Proyecto Integrador II».
 */
export interface AttackDie {
  readonly count: number
  readonly sides: number
}

/**
 * Como se compone el Ataque de UN golpe: un valor base MAS, si el heroe tiene
 * dado, el resultado de lanzarlo.
 *
 * `base` es el Ataque EFECTIVO del heroe (`effectiveStats.attack` de
 * Player-Inventory: su base mas los modificadores permanentes del equipo) menos
 * lo que el equipo del objetivo le resta. `dice` es `null` cuando el Ataque no
 * lleva dado (no se lanza nada y no se consume ningun indice).
 */
export interface AttackProfile {
  readonly base: number
  readonly dice: AttackDie | null
}

/**
 * Dados de Ataque por subtipo, transcritos de la Tabla 6 («Ataque»):
 *
 *   Guerrero Tanque / Armas   10 + 1d6
 *   Mago Fuego / Hielo        10 + 1d8
 *   Picaro Veneno / Machete   10 + 1d10
 *   Chaman / Medico           -            (los sanadores no tienen Ataque)
 *
 * El «10» NO se guarda aqui: es la estadistica base que Catalog entrega y
 * Player-Inventory recalcula con el equipo. Catalog solo puede expresar el
 * Ataque base como un valor fijo O un dado, nunca «valor + dado», asi que la
 * parte del dado es una regla del juego por subtipo, igual que la Tabla 21 de
 * efectos (`BASE_EFFECT_PERCENTAGES`). La notacion de dados del propio documento
 * (seccion 6.1.1, junto a la formula de experiencia) dice que «1d8 indica que se
 * debe lanzar un dado de ocho caras y el resultado obtenido se utiliza en la
 * formula»: el dado SE LANZA.
 *
 * Solo cubre NIVEL 1: el sistema no tiene la nocion de nivel (Player-Inventory
 * confirmo que el dato no existe, DP-3) y el documento no da una formula para el
 * dado en niveles superiores.
 *
 * CONGELADO en runtime, como las demas reglas autoritativas del dominio.
 */
export const ATTACK_DICE: Readonly<Record<HeroSubtype, AttackDie | null>> = Object.freeze({
  [HeroSubtype.GuerreroTanque]: Object.freeze({ count: 1, sides: 6 }),
  [HeroSubtype.GuerreroArmas]: Object.freeze({ count: 1, sides: 6 }),
  [HeroSubtype.MagoFuego]: Object.freeze({ count: 1, sides: 8 }),
  [HeroSubtype.MagoHielo]: Object.freeze({ count: 1, sides: 8 }),
  [HeroSubtype.PicaroVeneno]: Object.freeze({ count: 1, sides: 10 }),
  [HeroSubtype.PicaroMachete]: Object.freeze({ count: 1, sides: 10 }),
  [HeroSubtype.Chaman]: null,
  [HeroSubtype.Medico]: null,
})

export const attackDiceFor = (subtype: HeroSubtype): AttackDie | null => ATTACK_DICE[subtype]

/**
 * Cara de un dado de `sides` caras a partir de un indice de la secuencia
 * centralizada (HU-24). Como el indice es uniforme en 1..8000, el 1..8000 se
 * reparte en `sides` tramos contiguos e iguales:
 *
 *   cara = floor((indice - 1) x sides / 8000) + 1
 *
 * Con 8 y 10 caras el reparto es EXACTO (1000 y 800 filas por cara); con 6 caras
 * 8000 no es multiplo, asi que dos caras reciben una fila mas (1334 contra 1333:
 * una diferencia de 0,075 % relativa, sin ningun efecto practico). No usa otra
 * fuente de aleatoriedad: la cara es funcion pura del indice.
 */
export const dieFaceFromIndex = (index: RandomIndex, sides: number): number => {
  if (!Number.isInteger(sides) || sides < 2) {
    throw new DomainError(`Un dado necesita al menos 2 caras enteras. Se recibio ${String(sides)}.`)
  }

  return Math.floor(((index.value - RandomIndex.MIN) * sides) / RandomIndex.MAX) + 1
}

/** Rechaza un dado mal formado ANTES de consumir ningun indice de la secuencia. */
export const assertAttackDie = (dice: AttackDie): void => {
  if (!Number.isInteger(dice.count) || dice.count < 1) {
    throw new DomainError(
      `El dado de Ataque necesita al menos 1 lanzamiento entero. Se recibio ${String(dice.count)}.`,
    )
  }

  if (!Number.isInteger(dice.sides) || dice.sides < 2) {
    throw new DomainError(
      `El dado de Ataque necesita al menos 2 caras enteras. Se recibio ${String(dice.sides)}.`,
    )
  }
}
