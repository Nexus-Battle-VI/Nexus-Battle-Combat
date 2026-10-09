import type { Db } from 'mongodb'

/**
 * Amplia el validador de `ai-model-versions`/`ai-model-artifacts`
 * (migracion `027`, ya mergeada en `develop`) para EN-037.3 (Management
 * #572): `027` NO se edita (historia congelada, mismo criterio que
 * `021`), esta migracion amplia lo vigente sin reemplazarlo.
 *
 * Tres cambios, los tres aditivos (un documento ya persistido por `027`
 * sigue siendo valido sin cambios):
 *
 * 1. `state` y `stateHistory[].from`/`stateHistory[].to` ganan el valor
 *    `SUPERSEDED` (#572 §8): el unico estado que libera el indice unico
 *    parcial `active_unique` para que otra version se vuelva ACTIVE, y el
 *    unico origen legitimo de un rollback.
 * 2. `artifactLineage` (cuando no es `null`) admite el campo
 *    `parityReferenceSha256` (#572 §6): el SHA-256 de
 *    `pytorch-parity-reference.json`, generado por la herramienta YA
 *    existente `nexus-combat-parity-reference` (#569) durante el handoff
 *    de `#571` ANTES de borrar el work dir -- sin esto, el gate de
 *    paridad de `#572` no tendria ninguna referencia PyTorch durable que
 *    comparar.
 * 3. `ai-model-artifacts.artifactType` gana el valor `PARITY_REFERENCE`,
 *    para poder persistir ese JSON content-addressed igual que ya se
 *    persiste `model.onnx`.
 *
 * Idempotente: si los tres patches ya se aplicaron (reintento de la
 * migracion), `patched` sale en 0 para cada uno y no se ejecuta `collMod`.
 */

const PREVIOUS_LIFECYCLE_STATES = [
  'TRAINING',
  'CANDIDATE',
  'EVALUATING',
  'ACTIVE',
  'REJECTED',
] as const
const WIDENED_LIFECYCLE_STATES = [...PREVIOUS_LIFECYCLE_STATES, 'SUPERSEDED'] as const

const PREVIOUS_ARTIFACT_TYPES = ['ONNX_MODEL'] as const
const WIDENED_ARTIFACT_TYPES = [...PREVIOUS_ARTIFACT_TYPES, 'PARITY_REFERENCE'] as const

const PARITY_REFERENCE_SHA256_SCHEMA = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{64}$',
} as const

type Schema = Record<string, unknown>

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sameSet = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) &&
  value.length === expected.length &&
  expected.every((item) => value.includes(item))

/** Generaliza el patron de `021-battle-rooms-epic-stat-effects.ts`: amplia CUALQUIER `enum` que coincida exactamente con `previous`, sin importar la clave que lo contiene (cubre `state` y las dos ramas de `stateHistory[].from`/`.to` de una sola pasada, las tres comparten el MISMO array literal). */
const widenEnumsEverywhere = (
  node: unknown,
  previous: readonly string[],
  widened: readonly string[],
): { readonly value: unknown; readonly patched: number } => {
  if (Array.isArray(node)) {
    const results = node.map((item) => widenEnumsEverywhere(item, previous, widened))
    return {
      value: results.map((result) => result.value),
      patched: results.reduce((total, result) => total + result.patched, 0),
    }
  }

  if (!isRecord(node)) return { value: node, patched: 0 }

  let patched = 0
  const copy: Schema = {}

  for (const [key, child] of Object.entries(node)) {
    if (key === 'enum' && sameSet(child, previous)) {
      copy[key] = [...widened]
      patched += 1
      continue
    }
    const result = widenEnumsEverywhere(child, previous, widened)
    copy[key] = result.value
    patched += result.patched
  }

  return { value: copy, patched }
}

/** Encuentra el nodo `artifactLineage` por su firma y admite `parityReferenceSha256`.
 * No lo vuelve obligatorio en Mongo: documentos historicos de #570 ya persistidos
 * no pueden fabricar una referencia PyTorch que nunca conservaron. Los candidatos
 * NUEVOS si lo exigen en `AiModelRegistry.registerCandidate`/dominio. */
const addParityReferenceField = (
  node: unknown,
): { readonly value: unknown; readonly patched: number } => {
  if (Array.isArray(node)) {
    const results = node.map(addParityReferenceField)
    return {
      value: results.map((result) => result.value),
      patched: results.reduce((total, result) => total + result.patched, 0),
    }
  }

  if (!isRecord(node)) return { value: node, patched: 0 }

  const properties = node.properties
  const isArtifactLineageObject =
    node.bsonType === 'object' &&
    isRecord(properties) &&
    'onnxArtifactSha256' in properties &&
    'metricsFileSha256' in properties &&
    !('parityReferenceSha256' in properties)

  if (isArtifactLineageObject) {
    return {
      value: {
        ...node,
        properties: { ...properties, parityReferenceSha256: PARITY_REFERENCE_SHA256_SCHEMA },
      },
      patched: 1,
    }
  }

  let patched = 0
  const copy: Schema = {}
  for (const [key, child] of Object.entries(node)) {
    const result = addParityReferenceField(child)
    copy[key] = result.value
    patched += result.patched
  }
  return { value: copy, patched }
}

const collModFromPatch = async (
  db: Db,
  collectionName: string,
  patch: (validator: Schema) => { readonly value: unknown; readonly patched: number },
): Promise<void> => {
  const [info] = await db.listCollections({ name: collectionName }).toArray()
  const options = (info as { options?: Schema } | undefined)?.options
  const validator = options?.validator

  if (!isRecord(validator)) {
    throw new Error(`${collectionName} no tiene un validador $jsonSchema que ampliar.`)
  }

  const { value, patched } = patch(validator)
  if (patched === 0) return // Idempotente: ya ampliado.

  await db.command({
    collMod: collectionName,
    validator: value,
    validationLevel:
      typeof options?.validationLevel === 'string' ? options.validationLevel : 'strict',
    validationAction:
      typeof options?.validationAction === 'string' ? options.validationAction : 'error',
  })
}

export const up = async (db: Db): Promise<void> => {
  await collModFromPatch(db, 'ai-model-versions', (validator) =>
    widenEnumsEverywhere(validator, PREVIOUS_LIFECYCLE_STATES, WIDENED_LIFECYCLE_STATES),
  )
  await collModFromPatch(db, 'ai-model-versions', addParityReferenceField)
  await collModFromPatch(db, 'ai-model-artifacts', (validator) =>
    widenEnumsEverywhere(validator, PREVIOUS_ARTIFACT_TYPES, WIDENED_ARTIFACT_TYPES),
  )
}
