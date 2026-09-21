import { InvalidProbabilityModifierError } from '../errors/RandomEffectErrors'
import { RandomEffectType, isRandomEffectType } from './RandomEffectType'

/**
 * Efectos a los que un modificador puede AUMENTAR probabilidad: todos menos
 * `NO_DAMAGE`, que es de donde sale la compensacion.
 */
export type IncreasableEffectType = Exclude<RandomEffectType, typeof RandomEffectType.NoDamage>

/** 1 fila = 1/8000 = 0,0125 % = 1,25 puntos basicos; 1 punto basico = 0,8 filas. */
const ROWS_PER_TEN_THOUSAND_BASIS_POINTS = 8000

/**
 * Modificador de probabilidad del equipamiento (HU-25, CA-04 y CA-06).
 *
 * Regla que HU-25 define: "todo incremento de probabilidad en un efecto debe
 * restarse de la probabilidad de 'no causar dano'" (Tabla 23: +6 % de critico
 * deja el critico en 11 % y 'no causar dano' en 24 %). Un modificador es una
 * CANTIDAD de filas de un efecto distinto de `NO_DAMAGE`: `withModifiers` la
 * suma (a costa de `NO_DAMAGE`) y `withReductions` la resta (devolviendola a
 * `NO_DAMAGE`, para «-2 % de critico al ataque del oponente»).
 *
 * Lo que NO se define y por tanto NO existe: cantidades negativas, aumentar o
 * reducir `NO_DAMAGE` ni repartir la compensacion entre varios efectos. Esos
 * casos fallan de forma explicita (`InvalidProbabilityModifierError`) en lugar
 * de adivinar una semantica.
 *
 * La cantidad se guarda en FILAS enteras, que es la representacion autoritativa
 * de la tabla. Nunca se redondea: un valor que no equivale a un numero exacto
 * de filas se rechaza. Las conversiones usan solo aritmetica entera (sin
 * decimales binarios: `0.1 + 0.2` no aparece).
 *
 * Este objeto NO sabe de donde sale el modificador. La traduccion de un efecto
 * de equipamiento (`CRITICAL_CHANCE INCREASE PERCENTAGE 300` = +3 puntos
 * porcentuales absolutos) la hace la capa de aplicacion (`BuildHeroEffectTable`),
 * no esta clase.
 */
export class ProbabilityModifier {
  readonly effect: IncreasableEffectType
  readonly rows: number

  private constructor(effect: IncreasableEffectType, rows: number) {
    this.effect = effect
    this.rows = rows
  }

  /** Incremento expresado directamente en filas de la tabla (entero >= 0). */
  static ofRows(effect: unknown, rows: unknown): ProbabilityModifier {
    if (!isRandomEffectType(effect)) {
      throw new InvalidProbabilityModifierError(
        `El efecto "${String(effect)}" no pertenece a la tabla de control.`,
      )
    }

    if (effect === RandomEffectType.NoDamage) {
      throw new InvalidProbabilityModifierError(
        'No existe regla para aumentar "no causar dano": es el efecto que compensa los demas incrementos.',
      )
    }

    if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 0) {
      throw new InvalidProbabilityModifierError(
        `El incremento debe ser un numero entero de filas mayor o igual a 0. Se recibio ${String(rows)}.`,
      )
    }

    return new ProbabilityModifier(effect, rows)
  }

  /**
   * Incremento expresado en puntos basicos de PROBABILIDAD ABSOLUTA de la tabla
   * (1 % = 100 pb; el "+6 % de critico" de la Tabla 23 son 600 pb = 480 filas).
   * Solo se acepta si equivale a un numero EXACTO de filas: 1 pb son 0,8 filas,
   * asi que solo los multiplos de 5 pb lo son. No hay redondeo.
   */
  static ofBasisPoints(effect: unknown, basisPoints: unknown): ProbabilityModifier {
    if (typeof basisPoints !== 'number' || !Number.isInteger(basisPoints) || basisPoints < 0) {
      throw new InvalidProbabilityModifierError(
        `El incremento debe ser un numero entero de puntos basicos mayor o igual a 0. Se recibio ${String(basisPoints)}.`,
      )
    }

    const scaled = basisPoints * ROWS_PER_TEN_THOUSAND_BASIS_POINTS

    if (scaled % 10_000 !== 0) {
      throw new InvalidProbabilityModifierError(
        `${String(basisPoints)} pb no equivalen a un numero exacto de filas (1 fila = 1,25 pb); no se redondea.`,
      )
    }

    return ProbabilityModifier.ofRows(effect, scaled / 10_000)
  }
}
