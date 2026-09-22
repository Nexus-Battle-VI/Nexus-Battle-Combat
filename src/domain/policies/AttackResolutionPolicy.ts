import { DomainError } from '../errors/DomainError'

/**
 * Resultado de comparar el Ataque de un golpe con la Defensa del objetivo
 * (HU-20, RF-20). Lleva los dos valores comparados para que quien lo consuma
 * (HU-18, HU-19, reglas que comparan estadisticas) no tenga que volver a
 * calcularlos.
 */
export interface AttackComparison {
  readonly attackValue: number
  readonly defenseValue: number
  /**
   * `true` SOLO si el Ataque SUPERA (estrictamente) la Defensa. Con Ataque igual
   * a la Defensa el golpe NO es efectivo: la HU distingue «no supera» (CA-04)
   * de «supera» (CA-05), y la igualdad no supera.
   */
  readonly effective: boolean
}

/**
 * Valida un valor de Ataque o de Defensa: entero no negativo. Es la misma forma
 * que Player-Inventory garantiza para las estadisticas efectivas (las redondea y
 * las acota en 0) y que el parser de Combat vuelve a exigir; aqui se comprueba de
 * nuevo porque esta regla puede recibir valores de otras fuentes (un enemigo de
 * mision, un valor ajustado por el estado de batalla).
 */
export const assertCombatValue = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError(`${label} debe ser un entero no negativo. Se recibio ${String(value)}.`)
  }
}

/**
 * Regla de HU-20: el golpe es efectivo si y solo si el Ataque supera la
 * Defensa. Funcion pura y sin estado: no toca aleatoriedad, no muta nada y no
 * sabe de heroes, turnos ni vida. Lo que ocurre despues de un golpe efectivo (el
 * efecto aleatorio de HU-25) lo orquesta `ResolveAttack`.
 */
export const compareAttackAgainstDefense = (
  attackValue: number,
  defenseValue: number,
): AttackComparison => {
  assertCombatValue(attackValue, 'El valor de Ataque')
  assertCombatValue(defenseValue, 'El valor de Defensa')

  return { attackValue, defenseValue, effective: attackValue > defenseValue }
}
