import { Long } from 'mongodb'

import type { MctsTeacherLabel } from '../../../domain/decision/MctsTeacherLabel'
import type { MctsTeacherResult } from '../../../domain/decision/MctsTeacherResult'
import { RandomSeed } from '../../../domain/value-objects/RandomSeed'

/**
 * MongoDB serializes a JavaScript integer above INT32_MAX as BSON `double`.
 * `simulationSeed` is a uint32, while migration 025 deliberately accepts
 * only integral BSON types. Use `Long` explicitly at this persistence
 * boundary so every valid seed is encoded as BSON `long`, including values
 * in the upper half of uint32.
 *
 * Reads also accept `number`: the MongoDB driver's default BSON promotion
 * returns a number for safe `long` values, and labels written before this
 * fix may contain BSON `int` for small seeds.
 */
type PersistedSimulationSeed = Long | number

type MctsTeacherLabelResultDocument = Omit<MctsTeacherResult, 'simulationSeed'> & {
  readonly simulationSeed: PersistedSimulationSeed
}

export type MctsTeacherLabelDocument = Omit<MctsTeacherLabel, 'eventId' | 'result'> & {
  readonly _id: string
  readonly result: MctsTeacherLabelResultDocument
}

export const toMctsTeacherLabelDocument = (label: MctsTeacherLabel): MctsTeacherLabelDocument => {
  const { eventId, result, ...payload } = label

  return {
    _id: eventId,
    ...payload,
    result: {
      ...result,
      simulationSeed: Long.fromNumber(RandomSeed.create(result.simulationSeed).value),
    },
  }
}

export const toMctsTeacherLabel = (document: MctsTeacherLabelDocument): MctsTeacherLabel => {
  const { _id, result, ...payload } = document
  const simulationSeed = Long.isLong(result.simulationSeed)
    ? result.simulationSeed.toNumber()
    : result.simulationSeed

  return {
    eventId: _id,
    ...payload,
    result: { ...result, simulationSeed: RandomSeed.create(simulationSeed).value },
  }
}

const canonicalJson = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

/**
 * `generatedAt` no forma parte de la identidad semantica de un label repetido:
 * mismo criterio que `occurredAt` en `combat-decision-event-mapping.ts`. Dos
 * invocaciones para el MISMO `eventId` producen, por construccion
 * (semilla derivada del propio `eventId`, misma sala pre-accion), el mismo
 * `result`; solo el reloj de pared puede diferir.
 */
export const sameMctsTeacherLabel = (left: MctsTeacherLabel, right: MctsTeacherLabel): boolean => {
  const normalize = (label: MctsTeacherLabel): Record<string, unknown> => {
    const semantic: Record<string, unknown> = { ...label }
    Reflect.deleteProperty(semantic, 'generatedAt')
    return semantic
  }

  return canonicalJson(normalize(left)) === canonicalJson(normalize(right))
}
