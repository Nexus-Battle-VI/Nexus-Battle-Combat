import {
  IncompleteEffectDistributionError,
  InsufficientNoDamageProbabilityError,
  InvalidEffectTableError,
} from '../errors/RandomEffectErrors'
import { RandomIndex } from '../value-objects/RandomIndex'
import { EFFECT_MAGNITUDES } from './EffectMagnitude'
import type { ProbabilityModifier } from './ProbabilityModifier'
import { RANDOM_EFFECT_ORDER, RandomEffectType } from './RandomEffectType'
import type { ResolvedRandomEffect } from './ResolvedRandomEffect'

/**
 * Filas de una tabla de control (RF-25): exactamente 8000. Es a proposito la
 * MISMA constante que el maximo de `RandomIndex` (HU-24): el dominio de los
 * indices y el de las filas son uno solo, de modo que un `RandomIndex` valido
 * siempre cae en una fila y no puede quedar ninguna fila sin indice.
 */
export const EFFECT_TABLE_ROWS = RandomIndex.MAX

/** Filas asignadas a cada efecto: la representacion AUTORITATIVA de la tabla. */
export type EffectRowCounts = Readonly<Record<RandomEffectType, number>>

/** Tramo contiguo de filas (ambas inclusivas) que corresponde a un efecto. */
export interface EffectRange {
  readonly effect: RandomEffectType
  readonly firstRow: number
  readonly lastRow: number
}

/**
 * Tabla de control de efectos aleatorios de 8000 filas (HU-25, RF-25).
 *
 * Se guarda como RANGOS CONTIGUOS y no como 8000 entradas: son semanticamente
 * equivalentes (las pruebas lo demuestran recorriendo las 8000 filas) y ocupa
 * seis rangos como mucho. La tabla garantiza POR CONSTRUCCION:
 *
 *  - exactamente 8000 filas, la primera es la 1 y la ultima la 8000;
 *  - rangos contiguos en el orden fijo de `RANDOM_EFFECT_ORDER`, sin huecos ni
 *    solapamientos, y un efecto con 0 filas no genera ningun rango;
 *  - todo `RandomIndex` valido resuelve EXACTAMENTE un efecto.
 *
 * Es inmutable y pura: no conoce NestJS, ni un generador, ni la semilla. Solo
 * traduce un indice ya generado (HU-24) en un efecto; jamas usa otra fuente de
 * aleatoriedad (RF-25, CA-07). Se prueba con `resolve(RandomIndex.create(1500))`
 * sin ninguna infraestructura.
 */
export class EffectControlTable {
  readonly #rowCounts: EffectRowCounts
  readonly #ranges: readonly EffectRange[]
  /** Todos los rangos salvo el ultimo, que siempre termina en la fila 8000. */
  readonly #leadingRanges: readonly EffectRange[]
  readonly #finalRange: EffectRange

  private constructor(
    rowCounts: EffectRowCounts,
    ranges: readonly EffectRange[],
    finalRange: EffectRange,
  ) {
    this.#rowCounts = rowCounts
    this.#ranges = ranges
    this.#leadingRanges = Object.freeze(ranges.slice(0, -1))
    this.#finalRange = finalRange
  }

  /**
   * Construye la tabla a partir de las filas de cada efecto. Rechaza (sin
   * corregir en silencio) filas no enteras o negativas, efectos desconocidos o
   * ausentes y cualquier suma distinta de 8000.
   */
  static fromRowCounts(raw: EffectRowCounts): EffectControlTable {
    const unknown = Object.keys(raw).filter(
      (key) => !(RANDOM_EFFECT_ORDER as readonly string[]).includes(key),
    )

    if (unknown.length > 0) {
      throw new InvalidEffectTableError(
        `La distribucion contiene efectos desconocidos: ${unknown.join(', ')}.`,
      )
    }

    for (const effect of RANDOM_EFFECT_ORDER) {
      const rows: unknown = raw[effect]

      if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 0) {
        throw new InvalidEffectTableError(
          `Las filas de "${effect}" deben ser un entero mayor o igual a 0. Se recibio ${String(rows)}.`,
        )
      }
    }

    const ranges: EffectRange[] = []
    let nextRow = 1

    for (const effect of RANDOM_EFFECT_ORDER) {
      const rows = raw[effect]

      if (rows > 0) {
        ranges.push(Object.freeze({ effect, firstRow: nextRow, lastRow: nextRow + rows - 1 }))
        nextRow += rows
      }
    }

    const finalRange = ranges[ranges.length - 1]

    // Sin rangos (suma 0) o ultimo rango distinto de la fila 8000: la
    // distribucion no cubre exactamente la tabla.
    if (finalRange?.lastRow !== EFFECT_TABLE_ROWS) {
      throw new IncompleteEffectDistributionError(nextRow - 1)
    }

    return new EffectControlTable(Object.freeze({ ...raw }), Object.freeze(ranges), finalRange)
  }

  /** Filas asignadas a un efecto (0 si no ocupa ningun rango). */
  rowsOf(effect: RandomEffectType): number {
    return this.#rowCounts[effect]
  }

  /** Rangos no vacios, en el orden fijo de la tabla. */
  get ranges(): readonly EffectRange[] {
    return this.#ranges
  }

  /**
   * Efecto y magnitud de la fila seleccionada por el indice. Operacion pura:
   * el indice es el UNICO selector, y siempre resuelve exactamente una fila.
   */
  resolve(index: RandomIndex): ResolvedRandomEffect {
    for (const range of this.#leadingRanges) {
      if (index.value <= range.lastRow) {
        return EffectControlTable.#toResult(range.effect)
      }
    }

    return EffectControlTable.#toResult(this.#finalRange.effect)
  }

  /**
   * Nueva tabla con los incrementos aplicados (RF-25: todo aumento se resta
   * de "no causar dano"). La original no cambia. Los incrementos son aditivos
   * y el resultado no depende del orden en que se listen. Si la suma supera las
   * filas de "no causar dano" disponibles, falla en lugar de recortar.
   */
  withModifiers(modifiers: readonly ProbabilityModifier[]): EffectControlTable {
    const next: Record<RandomEffectType, number> = { ...this.#rowCounts }
    let requestedRows = 0

    for (const modifier of modifiers) {
      next[modifier.effect] += modifier.rows
      requestedRows += modifier.rows
    }

    const available = this.#rowCounts[RandomEffectType.NoDamage]

    if (requestedRows > available) {
      throw new InsufficientNoDamageProbabilityError(requestedRows, available)
    }

    next[RandomEffectType.NoDamage] = available - requestedRows

    return EffectControlTable.fromRowCounts(next)
  }

  static #toResult(effect: RandomEffectType): ResolvedRandomEffect {
    return { effect, magnitude: EFFECT_MAGNITUDES[effect] }
  }
}
