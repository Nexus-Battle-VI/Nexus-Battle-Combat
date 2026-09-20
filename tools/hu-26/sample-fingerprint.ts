import { createHash } from 'node:crypto'

/**
 * Codificacion y huellas de las muestras de HU-26.
 *
 * Las muestras (100.000 x 11 doubles) NO se commitean: se REGENERAN
 * deterministicamente desde el codigo productivo. Lo que si queda como evidencia
 * son estas huellas, para poder comprobar que una regeneracion produce EXACTAMENTE
 * los mismos datos y detectar cualquier cambio involuntario del generador.
 *
 * `node:crypto` se usa SOLO para SHA-256 (integridad). No interviene ninguna
 * fuente de aleatoriedad.
 */
export const encodeFloat64LittleEndian = (sample: Float64Array): Buffer => {
  const buffer = Buffer.alloc(sample.length * 8)

  sample.forEach((value, position) => {
    buffer.writeDoubleLE(value, position * 8)
  })

  return buffer
}

export const encodeUint16LittleEndian = (sample: Uint16Array): Buffer => {
  const buffer = Buffer.alloc(sample.length * 2)

  sample.forEach((value, position) => {
    buffer.writeUInt16LE(value, position * 2)
  })

  return buffer
}

export const sha256Hex = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

export interface SampleAnchor {
  readonly position: number
  readonly value: number
}

export interface NormalSampleFingerprint {
  readonly seed: number
  readonly sampleSize: number
  /** SHA-256 del fichero binario Float64 little-endian que lee el analisis. */
  readonly sha256: string
  readonly sum: number
  readonly sumOfSquares: number
  readonly anchors: readonly SampleAnchor[]
}

export interface IndexSampleFingerprint {
  readonly seed: number
  readonly sampleSize: number
  /** SHA-256 del fichero binario Uint16 little-endian. */
  readonly sha256: string
  readonly minimum: number
  readonly maximum: number
}

/** Posiciones fijas: las cinco primeras, un decimo, la mitad y la ultima. */
export const anchorPositions = (sampleSize: number): readonly number[] =>
  [0, 1, 2, 3, 4, Math.floor(sampleSize / 10) - 1, Math.floor(sampleSize / 2) - 1, sampleSize - 1]
    .filter((position) => position >= 0 && position < sampleSize)
    .filter((position, index, all) => all.indexOf(position) === index)

const valueAt = (sample: Float64Array, position: number): number => {
  const value = sample[position]

  if (value === undefined) {
    throw new RangeError(`La posicion ${String(position)} esta fuera de la muestra.`)
  }

  return value
}

export const fingerprintNormalSample = (
  seed: number,
  sample: Float64Array,
): NormalSampleFingerprint => {
  let sum = 0
  let sumOfSquares = 0

  for (const value of sample) {
    sum += value
    sumOfSquares += value * value
  }

  return {
    seed,
    sampleSize: sample.length,
    sha256: sha256Hex(encodeFloat64LittleEndian(sample)),
    sum,
    sumOfSquares,
    anchors: anchorPositions(sample.length).map((position) => ({
      position,
      value: valueAt(sample, position),
    })),
  }
}

export const fingerprintIndexSample = (
  seed: number,
  sample: Uint16Array,
): IndexSampleFingerprint => {
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY

  for (const value of sample) {
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  }

  return {
    seed,
    sampleSize: sample.length,
    sha256: sha256Hex(encodeUint16LittleEndian(sample)),
    minimum,
    maximum,
  }
}
