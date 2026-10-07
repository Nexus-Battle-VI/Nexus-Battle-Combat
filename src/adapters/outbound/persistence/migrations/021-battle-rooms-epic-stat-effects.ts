import type { Db } from 'mongodb'

/**
 * Amplia el `enum` de `activeSkillEffects[].statistic` (migracion `016`, ya mergeada en
 * `develop`) para aceptar tambien `CRITICAL_CHANCE` y `POWER` (correccion HU-19/HU-31 tras
 * GAP-HU31-CATALOG-MULTI-EFFECT, `EpicSkillPolicy`): una epica puede registrar un bono
 * TEMPORAL sobre esas dos estadisticas (p.ej. "+2% critico" de Golpe de defensa, Tabla 20),
 * aunque hoy ningun punto de resolucion las CONSULTE todavia (`P-HU31-STAT-CONSULTATION-GAP`,
 * documentado en `EpicSkillPolicy.ts`) -- se registran igual que ya se registra `IMMUNITY`
 * para habilidades, sin que el motor la aplique.
 *
 * `016` ya esta en `develop`: NO se edita (historia congelada, mismo criterio que `017`/`018`/
 * `020`). Esta migracion AMPLIA el `enum` vigente, nunca lo reemplaza por uno distinto: un
 * documento persistido con `ATTACK`/`DAMAGE`/`DEFENSE`/`HEALING` sigue siendo valido.
 *
 * NO REPITE EL VALIDADOR ENTERO. Busca, en cualquier profundidad, un nodo `statistic` cuyo
 * `enum` sea EXACTAMENTE el conjunto de `016` (para no tocar un enum distinto por accidente) y
 * lo sustituye por el conjunto ampliado. Es idempotente.
 */
const PREVIOUS_STATISTICS = ['ATTACK', 'DAMAGE', 'DEFENSE', 'HEALING'] as const
const WIDENED_STATISTICS = [...PREVIOUS_STATISTICS, 'CRITICAL_CHANCE', 'POWER'] as const

type Schema = Record<string, unknown>

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sameEnum = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) &&
  value.length === expected.length &&
  expected.every((item) => value.includes(item))

const widenStatisticEnum = (
  node: unknown,
): { readonly value: unknown; readonly patched: number } => {
  if (Array.isArray(node)) {
    const results = node.map(widenStatisticEnum)

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
    if (key === 'statistic' && isRecord(child) && sameEnum(child.enum, PREVIOUS_STATISTICS)) {
      copy[key] = { ...child, enum: [...WIDENED_STATISTICS] }
      patched += 1
      continue
    }

    const result = widenStatisticEnum(child)
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

  const { value, patched } = widenStatisticEnum(validator)

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
