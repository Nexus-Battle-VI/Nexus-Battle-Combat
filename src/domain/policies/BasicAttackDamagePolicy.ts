import type { CombatMagnitude } from '../entities/CombatProfile'
import { UnsupportedCombatProfileError } from '../errors/BattleErrors'
import { DomainError } from '../errors/DomainError'

/**
 * Del Dano del heroe a los puntos de Vida (HU-18, RF-18).
 *
 * Flujo, que no confunde Ataque con Dano:
 *
 *   Ataque > Defensa ?           HU-20: solo COMPARA
 *        |
 *   efecto (porcentaje)          HU-25
 *        |
 *   dano base del heroe          `effectiveStats.damage`: DICE se tira, FIXED se usa
 *        |
 *   dano calculado = floor( dano base x porcentaje / 100 )
 *        |
 *   dano aplicado  = min( dano calculado, Vida actual )
 *
 * Nunca `Vida -= Ataque` ni `dano = Ataque - Defensa`: el Ataque no es el Dano.
 *
 * REDONDEO: `floor`. El documento oficial no lo define; lo aclaro formalmente el
 * solicitante el 2026-09-21 (Management #62, comentario 5761290722). No es un
 * requisito original de la historia.
 */
export const MAX_EFFECT_PERCENT = 180

/** Dano soportado: solo las semanticas formalmente conocidas. */
export type SupportedDamage =
  | { readonly mode: 'FIXED'; readonly amount: number }
  | { readonly mode: 'DICE'; readonly count: number; readonly sides: number }

/**
 * Comprueba ANTES de consumir un solo sorteo que el Dano del atacante se puede
 * materializar. `null` (sanadores) y `PERCENTAGE` (ninguna fuente formal dice
 * sobre que base actuaria un porcentaje: no se inventa) se rechazan; los valores
 * invalidos tambien, para que una entrada mala jamas avance la secuencia.
 */
export const assertSupportedDamage = (magnitude: CombatMagnitude | null): SupportedDamage => {
  if (magnitude === null) {
    throw new UnsupportedCombatProfileError('el heroe no tiene Dano (sanador).')
  }

  if (magnitude.mode === 'PERCENTAGE') {
    throw new UnsupportedCombatProfileError(
      'un Dano en porcentaje no tiene una base formalmente definida.',
    )
  }

  if (magnitude.mode === 'FIXED') {
    if (!Number.isInteger(magnitude.amount) || magnitude.amount < 0) {
      throw new UnsupportedCombatProfileError('un Dano fijo necesita un entero no negativo.')
    }

    return { mode: 'FIXED', amount: magnitude.amount }
  }

  if (
    !Number.isInteger(magnitude.count) ||
    magnitude.count < 1 ||
    !Number.isInteger(magnitude.sides) ||
    magnitude.sides < 2
  ) {
    throw new UnsupportedCombatProfileError(
      'un Dano en dados necesita count >= 1 y sides >= 2, ambos enteros.',
    )
  }

  return { mode: 'DICE', count: magnitude.count, sides: magnitude.sides }
}

/** `floor(dano base x porcentaje / 100)`: aritmetica entera, sin decimales intermedios que sobrevivan. */
export const calculateDamage = (baseDamage: number, percent: number): number => {
  if (!Number.isInteger(baseDamage) || baseDamage < 0) {
    throw new DomainError(
      `El dano base debe ser un entero no negativo. Se recibio ${String(baseDamage)}.`,
    )
  }

  if (!Number.isInteger(percent) || percent < 0 || percent > MAX_EFFECT_PERCENT) {
    throw new DomainError(
      `El porcentaje del efecto debe ser un entero entre 0 y ${String(MAX_EFFECT_PERCENT)}. Se recibio ${String(percent)}.`,
    )
  }

  return Math.floor((baseDamage * percent) / 100)
}

export interface AppliedDamage {
  readonly calculatedDamage: number
  readonly appliedDamage: number
  readonly healthBefore: number
  readonly healthAfter: number
}

/**
 * Aplica el dano a la Vida: nunca baja de 0 (`overkill`). Se conservan separados
 * el dano calculado y el aplicado por trazabilidad.
 */
export const applyDamage = (currentHealth: number, calculatedDamage: number): AppliedDamage => {
  if (!Number.isInteger(currentHealth) || currentHealth < 0) {
    throw new DomainError('La Vida actual debe ser un entero no negativo.')
  }

  if (!Number.isInteger(calculatedDamage) || calculatedDamage < 0) {
    throw new DomainError('El dano calculado debe ser un entero no negativo.')
  }

  const appliedDamage = Math.min(calculatedDamage, currentHealth)

  return {
    calculatedDamage,
    appliedDamage,
    healthBefore: currentHealth,
    healthAfter: currentHealth - appliedDamage,
  }
}
