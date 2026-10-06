import type { MctsTeacherLabel } from '../../../domain/decision/MctsTeacherLabel'

export type MctsTeacherLabelDocument = Omit<MctsTeacherLabel, 'eventId'> & {
  readonly _id: string
}

export const toMctsTeacherLabelDocument = (label: MctsTeacherLabel): MctsTeacherLabelDocument => {
  const { eventId, ...payload } = label

  return { _id: eventId, ...payload }
}

export const toMctsTeacherLabel = (document: MctsTeacherLabelDocument): MctsTeacherLabel => {
  const { _id, ...payload } = document

  return { eventId: _id, ...payload }
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
