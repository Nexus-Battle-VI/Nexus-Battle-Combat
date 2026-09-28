import type { Db } from 'mongodb'

/**
 * Anade `level` (HU-08, CA-06) al perfil de combate congelado dentro de `battle-rooms`.
 *
 * El perfil (`combatProfile`) lleva ahora el nivel del heroe (`1..8`), que multiplica el
 * resultado final del Dano (`applyLevelToMagnitudeResult`, opcion A). El validador de `016`
 * tiene `additionalProperties: false` en el perfil: sin esta migracion, CUALQUIER batalla
 * nueva fallaria al persistir el perfil con `level`.
 *
 * ADITIVA Y RETROCOMPATIBLE, NO DESTRUCTIVA -- MISMO CRITERIO que `003`..`016`: `level` es
 * OPCIONAL (no entra en `required`) y ningun documento necesita backfill: un perfil sin `level`
 * se restaura como nivel 1.
 *
 * NO REPITE EL VALIDADOR ENTERO. Lee el validador VIGENTE de la coleccion y anade la propiedad
 * unicamente en los esquemas que son un perfil de combate (los que declaran `maxPower` y
 * `subtype` y prohiben propiedades extra). Asi `001`..`016` quedan congeladas y esta no copia
 * un esquema de 300 lineas que otra migracion podria cambiar. Es idempotente.
 */
const LEVEL_SCHEMA = { bsonType: 'number', minimum: 1, maximum: 8 } as const

type Schema = Record<string, unknown>

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Un esquema es "el perfil" si declara a la vez `maxPower`, `subtype` y `heroId`. */
const isCombatProfileSchema = (schema: Schema): boolean => {
  const properties = schema.properties

  return (
    isRecord(properties) &&
    'maxPower' in properties &&
    'subtype' in properties &&
    'heroId' in properties
  )
}

const addLevel = (node: unknown): { readonly value: unknown; readonly patched: number } => {
  if (Array.isArray(node)) {
    const results = node.map(addLevel)

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
    const result = addLevel(child)
    copy[key] = result.value
    patched += result.patched
  }

  if (isCombatProfileSchema(copy)) {
    const properties = copy.properties as Schema

    if (!('level' in properties)) {
      copy.properties = { ...properties, level: LEVEL_SCHEMA }
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

  const { value, patched } = addLevel(validator)

  if (patched === 0) {
    // Idempotente: ya lleva `level` en todos los perfiles.
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
