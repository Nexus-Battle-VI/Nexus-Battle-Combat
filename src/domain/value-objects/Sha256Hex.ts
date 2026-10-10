import { DomainError } from '../errors/DomainError'

/**
 * Validador centralizado de un SHA-256 hexadecimal (EN-037.1, Management
 * #570 §72): una sola autoridad, nunca una regex duplicada por archivo.
 * Usado por el model registry para `modelStateSha256`/`onnxArtifactSha256`/
 * `pytorchArtifactSha256`/`metricsFileSha256`/`trainingConfigSha256`.
 */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i

export class InvalidSha256HexError extends DomainError {
  constructor(field: string) {
    super(`"${field}" debe ser un SHA-256 hexadecimal de 64 caracteres.`)
    this.name = 'InvalidSha256HexError'
  }
}

export const isSha256Hex = (value: string): boolean => SHA256_HEX_PATTERN.test(value)

export const assertSha256Hex = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !isSha256Hex(value)) {
    throw new InvalidSha256HexError(field)
  }
  return value.toLowerCase()
}
