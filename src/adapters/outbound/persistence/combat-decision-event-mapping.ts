import type {
  CombatDecisionEvent,
  CombatDecisionOutcomeEvent,
  CombatDecisionTelemetryEvent,
} from '../../../domain/decision/CombatDecisionEvent'

export type CombatDecisionTelemetryDocument = Omit<CombatDecisionTelemetryEvent, 'eventId'> & {
  readonly _id: string
}

export const toCombatDecisionTelemetryDocument = (
  event: CombatDecisionTelemetryEvent,
): CombatDecisionTelemetryDocument => {
  const { eventId, ...payload } = event

  return { _id: eventId, ...payload }
}

export const toCombatDecisionTelemetryEvent = (
  document: CombatDecisionTelemetryDocument,
): CombatDecisionTelemetryEvent => {
  const { _id, ...payload } = document

  return { eventId: _id, ...payload } as CombatDecisionTelemetryEvent
}

const normalize = (event: CombatDecisionTelemetryEvent): Record<string, unknown> => {
  const semantic: Record<string, unknown> = { ...event }
  Reflect.deleteProperty(semantic, 'occurredAt')

  return semantic
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

/** `occurredAt` no forma parte de la identidad semántica de un reintento. */
export const sameCombatDecisionTelemetryEvent = (
  left: CombatDecisionTelemetryEvent,
  right: CombatDecisionTelemetryEvent,
): boolean => canonicalJson(normalize(left)) === canonicalJson(normalize(right))

export const isDecisionEvent = (
  event: CombatDecisionTelemetryEvent,
): event is CombatDecisionEvent => event.eventType === 'COMBAT_DECISION'

export const isOutcomeEvent = (
  event: CombatDecisionTelemetryEvent,
): event is CombatDecisionOutcomeEvent => event.eventType === 'COMBAT_DECISION_OUTCOME'
