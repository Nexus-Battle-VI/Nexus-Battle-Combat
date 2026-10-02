import type { Db } from 'mongodb'

/**
 * Anade `epic` (HU-31, contrato `hu-31-equipped-epic-v1` §8) al perfil de combate
 * congelado dentro de `battle-rooms` (`battle.combatants[].profile`).
 *
 * ADITIVA Y RETROCOMPATIBLE, NO DESTRUCTIVA -- MISMO CRITERIO que `003`..`019`: `epic` es
 * OPCIONAL (no entra en `required`) y ningun documento existente necesita backfill: un perfil
 * sin `epic` se restaura como "sin epica equipada" (misma clave ausente que el contrato de
 * Player-Inventory). Los documentos ya persistidos sin el campo siguen siendo validos: MongoDB
 * no revalida en reposo lo ya almacenado.
 *
 * `baseEffect`/`specificEffect`/`applied.*` son objetos OPACOS para Combat (ver `CombatProfile.ts`,
 * `validateEpic`): el esquema solo exige "objeto, o null donde el contrato lo permite", sin
 * enumerar sus propiedades internas -- interpretarlas es de una Task/HU futura, no de este
 * congelamiento.
 *
 * NO REPITE EL VALIDADOR ENTERO (mismo patron que `017`/`018`): lee el validador VIGENTE de la
 * coleccion y anade la propiedad unicamente en los esquemas que son "el perfil de combate" (los
 * que declaran a la vez `maxPower`, `subtype` y `heroId`). Es idempotente.
 */
const EPIC_APPLIED_SCHEMA = {
  bsonType: 'object',
  required: ['baseApplied', 'additionalApplied'],
  additionalProperties: false,
  properties: {
    baseApplied: { bsonType: ['object', 'null'] },
    additionalApplied: { bsonType: ['object', 'null'] },
  },
} as const

const EPIC_SCHEMA = {
  bsonType: 'object',
  required: [
    'epicProductId',
    'epicReference',
    'name',
    'compatibleHeroSubtype',
    'baseEffect',
    'specificEffect',
    'applied',
  ],
  additionalProperties: false,
  properties: {
    epicProductId: { bsonType: 'string', minLength: 1 },
    epicReference: { bsonType: 'string', minLength: 1 },
    name: { bsonType: 'string', minLength: 1 },
    compatibleHeroSubtype: { bsonType: 'string', minLength: 1 },
    baseEffect: { bsonType: ['object', 'null'] },
    specificEffect: { bsonType: 'object' },
    applied: EPIC_APPLIED_SCHEMA,
  },
} as const

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

const addEpic = (node: unknown): { readonly value: unknown; readonly patched: number } => {
  if (Array.isArray(node)) {
    const results = node.map(addEpic)

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
    const result = addEpic(child)
    copy[key] = result.value
    patched += result.patched
  }

  if (isCombatProfileSchema(copy)) {
    const properties = copy.properties as Schema

    if (!('epic' in properties)) {
      copy.properties = { ...properties, epic: EPIC_SCHEMA }
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

  const { value, patched } = addEpic(validator)

  if (patched === 0) {
    // Idempotente: ya lleva `epic` en todos los perfiles.
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
