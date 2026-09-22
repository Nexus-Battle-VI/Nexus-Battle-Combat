import { DomainError } from '../errors/DomainError'

/**
 * De la magnitud de curacion de una habilidad a los puntos de Vida (excepcion de
 * HU-12, Tabla 7 del documento oficial).
 *
 * Solo se soporta magnitud `PERCENTAGE` (1 a 10000 puntos base, i.e. 0.01% a
 * 100%), del maximo de Vida del OBJETIVO -- "Sana el 100% de la vida del
 * companero" (Reanimacion, Medico): el 100% de SU maximo, no una fraccion de lo
 * que le falta ni del maximo de quien cura. `FIXED`/`DICE` quedan fuera: ninguna
 * habilidad soportada hoy (unicamente Reanimacion) los necesita, y `SkillEffectPolicy`
 * los rechaza antes de llegar aqui.
 *
 * Determinista: a diferencia del dano (HU-18/HU-20), curar no consume ningun
 * sorteo de la secuencia HU-24 -- el documento oficial no describe una tirada
 * para sanar, y Tabla 21 (el roll de efecto) le da a los sanadores 100% `NoDamage`
 * porque nunca lo consultan para esta accion.
 */
export const MAX_HEALING_BASIS_POINTS = 10_000

export const calculateHeal = (maxHealth: number, basisPoints: number): number => {
  if (!Number.isInteger(maxHealth) || maxHealth < 0) {
    throw new DomainError(
      `La Vida maxima del objetivo debe ser un entero no negativo. Se recibio ${String(maxHealth)}.`,
    )
  }

  if (!Number.isInteger(basisPoints) || basisPoints < 1 || basisPoints > MAX_HEALING_BASIS_POINTS) {
    throw new DomainError(
      `Los puntos base de curacion deben ser un entero entre 1 y ${String(MAX_HEALING_BASIS_POINTS)}. Se recibio ${String(basisPoints)}.`,
    )
  }

  return Math.floor((maxHealth * basisPoints) / MAX_HEALING_BASIS_POINTS)
}

export interface AppliedHeal {
  readonly calculatedHeal: number
  readonly appliedHeal: number
  readonly healthBefore: number
  readonly healthAfter: number
}

/**
 * Aplica la curacion a la Vida: nunca sube del maximo (sin "overheal"). Se
 * conservan separados el calculado y el aplicado por trazabilidad, mismo
 * criterio que `applyDamage`.
 */
export const applyHeal = (
  currentHealth: number,
  maxHealth: number,
  calculatedHeal: number,
): AppliedHeal => {
  if (!Number.isInteger(currentHealth) || currentHealth < 0) {
    throw new DomainError('La Vida actual debe ser un entero no negativo.')
  }

  if (!Number.isInteger(calculatedHeal) || calculatedHeal < 0) {
    throw new DomainError('La curacion calculada debe ser un entero no negativo.')
  }

  const appliedHeal = Math.min(calculatedHeal, maxHealth - currentHealth)

  return {
    calculatedHeal,
    appliedHeal,
    healthBefore: currentHealth,
    healthAfter: currentHealth + appliedHeal,
  }
}
