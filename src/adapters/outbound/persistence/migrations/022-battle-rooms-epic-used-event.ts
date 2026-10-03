import type { Db } from 'mongodb'

/**
 * Amplia el `enum` de `events[].type` (migracion `016`, ya mergeada en `develop`) para
 * aceptar `epicUsed` (correccion HU-19/HU-31 tras GAP-HU31-CATALOG-MULTI-EFFECT): `UseEpic`
 * registra este tipo de evento en la bitacora de la sala, igual que `UseSkill` registra
 * `skillUsed`/`healSkillUsed`/`directDamageSkillUsed`.
 *
 * `016` ya esta en `develop`: NO se edita (historia congelada, mismo criterio que `017`/`018`/
 * `020`/`021`). Esta migracion AMPLIA el `enum` vigente, nunca lo reemplaza por uno distinto: un
 * documento persistido con cualquiera de los tipos anteriores sigue siendo valido.
 *
 * NO REPITE EL VALIDADOR ENTERO. Busca, en cualquier profundidad, un nodo `type` cuyo `enum` sea
 * EXACTAMENTE el conjunto vigente de tipos de evento (para no tocar un enum distinto por
 * accidente) y lo sustituye por el conjunto ampliado. Es idempotente.
 */
const PREVIOUS_EVENT_TYPES = [
  'battleStarted',
  'turnAdvanced',
  'basicAttackResolved',
  'skillUsed',
  'healSkillUsed',
  'turnTimedOut',
  'battleFinished',
  'directDamageSkillUsed',
] as const
const WIDENED_EVENT_TYPES = [...PREVIOUS_EVENT_TYPES, 'epicUsed'] as const

type Schema = Record<string, unknown>

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sameEnum = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) &&
  value.length === expected.length &&
  expected.every((item) => value.includes(item))

const widenEventTypeEnum = (
  node: unknown,
): { readonly value: unknown; readonly patched: number } => {
  if (Array.isArray(node)) {
    const results = node.map(widenEventTypeEnum)

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
    if (key === 'type' && isRecord(child) && sameEnum(child.enum, PREVIOUS_EVENT_TYPES)) {
      copy[key] = { ...child, enum: [...WIDENED_EVENT_TYPES] }
      patched += 1
      continue
    }

    const result = widenEventTypeEnum(child)
    copy[key] = result.value
    patched += result.patched
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

  const { value, patched } = widenEventTypeEnum(validator)

  if (patched === 0) {
    // Idempotente: el enum ya esta ampliado (o ya no queda el anterior para ampliar).
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
