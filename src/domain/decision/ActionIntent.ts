import type { DecisionActionTarget } from './LegalAction'

/** Elección de una política; no expresa daño, RNG ni estado resultante. */
export type ActionIntent =
  | { readonly kind: 'BASIC_ATTACK'; readonly target: DecisionActionTarget }
  | { readonly kind: 'ABILITY'; readonly abilityId: string; readonly target: DecisionActionTarget }
  | { readonly kind: 'EPIC'; readonly epicId: string; readonly target: DecisionActionTarget }
