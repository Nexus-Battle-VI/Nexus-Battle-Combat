import type { Db } from 'mongodb'

/**
 * Anade `unlockLevel` (EN-031) a cada habilidad congelada del perfil de combate dentro de
 * `battle-rooms`.
 *
 * Player-Inventory publica ahora el nivel desde el que se desbloquea cada habilidad
 * (`AbilityUnlockPolicy`: 1, 3 y 5 por posicion) y Combat lo congela con el perfil para
 * rechazar su uso (`SKILL_LOCKED`) mientras el nivel del heroe no llegue. El esquema de
 * habilidad de `016` tiene `additionalProperties: false`: sin esta migracion, CUALQUIER
 * batalla nueva fallaria al persistir una habilidad con `unlockLevel`.
 *
 * ADITIVA Y RETROCOMPATIBLE, NO DESTRUCTIVA -- MISMO CRITERIO que `017`: `unlockLevel` es
 * OPCIONAL (no entra en `required`) y ningun documento necesita backfill: una habilidad sin
 * `unlockLevel` se restaura desbloqueada (nivel 1).
 *
 * NO REPITE EL VALIDADOR ENTERO. Lee el validador VIGENTE de la coleccion y anade la
 * propiedad unicamente en los esquemas que son una habilidad congelada (los que declaran a
 * la vez `abilityId`, `powerCost`, `chargeTurns` y `effects`). Es idempotente.
 */
const UNLOCK_LEVEL_SCHEMA = { bsonType: 'number', minimum: 1, maximum: 8 } as const

type Schema = Record<string, unknown>

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAbilitySchema = (schema: Schema): boolean => {
  const properties = schema.properties

  return (
    isRecord(properties) &&
    'abilityId' in properties &&
    'powerCost' in properties &&
    'chargeTurns' in properties &&
    'effects' in properties
  )
}

const addUnlockLevel = (node: unknown): { readonly value: unknown; readonly patched: number } => {
  if (Array.isArray(node)) {
    const results = node.map(addUnlockLevel)

    return {
      value: results.map((result) => result.value),
      patched: results.reduce((total, result) => total + result.patched, 0),
    }
  }

  if (!isRecord(node)) {
    return { value: node, patched: 0 }
  }

  let patched = 0
  const copy: Schema = {}

  for (const [key, child] of Object.entries(node)) {
    const result = addUnlockLevel(child)
    copy[key] = result.value
    patched += result.patched
  }

  if (isAbilitySchema(copy)) {
    const properties = copy.properties as Schema

    if (!('unlockLevel' in properties)) {
      copy.properties = { ...properties, unlockLevel: UNLOCK_LEVEL_SCHEMA }
      patched += 1
    }
  }

  return { value: copy, patched }
}

export const up = async (db: Db): Promise<void> => {
  const [info] = await db.listCollections({ name: 'battle-rooms' }).toArray()
  const options = (info as { options?: Schema } | undefined)?.options
  const validator = options?.validator

  if (!isRecord(validator)) {
    throw new Error('battle-rooms no tiene un validador $jsonSchema que ampliar.')
  }

  const { value, patched } = addUnlockLevel(validator)

  if (patched === 0) {
    // Idempotente: todas las habilidades ya aceptan `unlockLevel`.
    return
  }

  await db.command({
    collMod: 'battle-rooms',
    validator: value,
    validationLevel:
      typeof options?.validationLevel === 'string' ? options.validationLevel : 'strict',
    validationAction:
      typeof options?.validationAction === 'string' ? options.validationAction : 'error',
  })
}
