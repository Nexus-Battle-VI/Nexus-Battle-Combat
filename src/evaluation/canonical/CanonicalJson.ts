import { createHash } from 'node:crypto'

/**
 * Serializacion JSON canonica (EN-036.5, Management #569 §81, §178): claves
 * ordenadas recursivamente, sin espacios, para que el mismo contenido
 * logico produzca SIEMPRE los mismos bytes -- la base de los fingerprints
 * SHA-256 de reproducibilidad. Usa `node:crypto` solo para hashear
 * (integridad/fingerprint), nunca para aleatoriedad -- mismo criterio ya
 * aceptado para `NeuralModelArtifactLoader.ts` y
 * `EvaluationSeedSchedule.ts`.
 */
const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    return Object.fromEntries(entries.map(([key, child]) => [key, sortKeysDeep(child)]))
  }

  return value
}

export const canonicalJsonStringify = (value: unknown): string =>
  JSON.stringify(sortKeysDeep(value))

export const sha256Hex = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

export const canonicalJsonSha256 = (value: unknown): string =>
  sha256Hex(canonicalJsonStringify(value))
