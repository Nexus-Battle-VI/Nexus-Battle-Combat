import type { CombatantKey } from '../entities/Combatant'

/** Acción que Combat ha probado como elegible en el snapshot actual. */
export type LegalAction =
  | { readonly kind: 'BASIC_ATTACK'; readonly target: CombatantKey }
  | { readonly kind: 'ABILITY'; readonly abilityId: string; readonly target: CombatantKey }
  | { readonly kind: 'EPIC'; readonly epicId: string; readonly target: CombatantKey | null }
