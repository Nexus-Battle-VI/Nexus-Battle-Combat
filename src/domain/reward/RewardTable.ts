import { InvalidRewardTableError } from '../errors/RewardTableErrors'
import { RandomIndex } from '../value-objects/RandomIndex'

/** Un producto real del Catalog, tal como lo registra la reward table versionada. */
export interface RewardEntry {
  readonly productId: string
  readonly sku: string
  readonly name: string
  readonly tierId: string
}

/** Tramo contiguo (ambos inclusive) que corresponde a un producto. */
export interface RewardRange {
  readonly entry: RewardEntry
  readonly firstRow: number
  readonly lastRow: number
}

export interface RewardRangeInput {
  readonly firstRow: number
  readonly lastRow: number
  readonly entry: RewardEntry
}

/**
 * Reward table del cofre (HU-22, `hu-22-reward-contract-v1` §5-6).
 *
 * MISMO patron que `EffectControlTable` (HU-25) y el MISMO espacio de 8000
 * filas que `RandomIndex` (HU-24): no es una tabla nueva de otro tamano, es
 * una segunda tabla sobre el mismo indice. Se guarda como tramos contiguos
 * -- no como 8000 entradas -- y garantiza POR CONSTRUCCION que cubren
 * exactamente `1..8000`, sin huecos ni solapes, en el orden dado.
 *
 * Es inmutable y pura: no conoce NestJS, RNG ni configuracion en bruto. Se
 * construye UNA vez en la composicion (`infrastructure/config/reward-table.ts`)
 * a partir del artefacto versionado y se reutiliza para todo cofre.
 */
export class RewardTable {
  static readonly ROWS = RandomIndex.MAX

  readonly #ranges: readonly RewardRange[]

  private constructor(ranges: readonly RewardRange[]) {
    this.#ranges = ranges
  }

  static fromRanges(input: readonly RewardRangeInput[]): RewardTable {
    if (input.length === 0) {
      throw new InvalidRewardTableError('La reward table no puede estar vacia.')
    }

    const sorted = [...input].sort((a, b) => a.firstRow - b.firstRow)
    let expected = 1

    for (const range of sorted) {
      if (
        !Number.isInteger(range.firstRow) ||
        !Number.isInteger(range.lastRow) ||
        range.firstRow > range.lastRow
      ) {
        throw new InvalidRewardTableError(
          `Tramo invalido para "${range.entry.productId}": ${String(range.firstRow)}-${String(range.lastRow)}.`,
        )
      }

      if (range.firstRow !== expected) {
        throw new InvalidRewardTableError(
          `Hueco o solape en la fila ${String(expected)}: el siguiente tramo empieza en ${String(range.firstRow)}.`,
        )
      }

      expected = range.lastRow + 1
    }

    if (expected - 1 !== RewardTable.ROWS) {
      throw new InvalidRewardTableError(
        `La reward table cubre hasta la fila ${String(expected - 1)}, se esperaban exactamente ${String(RewardTable.ROWS)}.`,
      )
    }

    return new RewardTable(sorted.map((range) => Object.freeze({ ...range })))
  }

  /** Producto de la fila seleccionada por el indice. Operacion pura, sin RNG propio. */
  resolve(index: RandomIndex): RewardEntry {
    // Busqueda lineal: 40 tramos, no 8000; el mismo criterio de simplicidad
    // que EffectControlTable (seis rangos como mucho) aplica aqui.
    for (const range of this.#ranges) {
      if (index.value >= range.firstRow && index.value <= range.lastRow) {
        return range.entry
      }
    }

    // Inalcanzable: `fromRanges` garantiza cobertura total de 1..8000 y
    // `RandomIndex` garantiza `1 <= value <= 8000` por construccion.
    throw new InvalidRewardTableError(`Ningun tramo cubre el indice ${String(index.value)}.`)
  }

  get ranges(): readonly RewardRange[] {
    return this.#ranges
  }
}
