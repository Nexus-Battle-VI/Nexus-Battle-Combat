import type { ActionIntent } from './ActionIntent'
import type { LegalAction } from './LegalAction'
import { IllegalActionIntentError } from '../errors/DecisionContractErrors'

const part = (value: string): string => `${String(value.length)}:${value}`

const targetParts = (
  target: { readonly teamLabel: string; readonly seat: number } | null,
): string[] => (target === null ? ['-', '-'] : [part(target.teamLabel), String(target.seat)])

/** Identidad canónica, explícita y no basada en serializar objetos arbitrarios. */
export const legalActionIdentity = (action: LegalAction): string => {
  switch (action.kind) {
    case 'BASIC_ATTACK':
      return ['BASIC_ATTACK', ...targetParts(action.target)].join('|')
    case 'ABILITY':
      return ['ABILITY', part(action.abilityId), ...targetParts(action.target)].join('|')
    case 'EPIC':
      return ['EPIC', part(action.epicId), ...targetParts(action.target)].join('|')
  }
}

const intentIdentity = (intent: ActionIntent): string => {
  switch (intent.kind) {
    case 'BASIC_ATTACK':
      return ['BASIC_ATTACK', ...targetParts(intent.target)].join('|')
    case 'ABILITY':
      return ['ABILITY', part(intent.abilityId), ...targetParts(intent.target)].join('|')
    case 'EPIC':
      return ['EPIC', part(intent.epicId), ...targetParts(intent.target)].join('|')
  }
}

/** Devuelve el candidato canónico o rechaza una intención inventada/no legal. */
export const resolveLegalAction = (
  intent: ActionIntent,
  legalActions: readonly LegalAction[],
): LegalAction => {
  const candidate: unknown = intent

  if (candidate === null || typeof candidate !== 'object') {
    throw new IllegalActionIntentError()
  }

  let identity: string

  try {
    identity = intentIdentity(candidate as ActionIntent)
  } catch {
    throw new IllegalActionIntentError()
  }

  const canonical = legalActions.find((action) => legalActionIdentity(action) === identity)

  if (canonical === undefined) {
    throw new IllegalActionIntentError()
  }

  return canonical
}

export const isLegalActionIntent = (
  intent: ActionIntent,
  legalActions: readonly LegalAction[],
): boolean => {
  try {
    resolveLegalAction(intent, legalActions)
    return true
  } catch {
    return false
  }
}
