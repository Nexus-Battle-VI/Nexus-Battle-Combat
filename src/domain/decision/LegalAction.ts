import type { CombatantKey } from '../entities/Combatant'

/** Alcance estratégico real de la acción; nunca usa un combatiente ficticio como placeholder. */
export type DecisionActionTarget =
  | { readonly scope: 'COMBATANT'; readonly combatant: CombatantKey }
  | { readonly scope: 'SELF' }
  | { readonly scope: 'ALLIED_GROUP' }

/** Acción que Combat ha probado como elegible en el snapshot actual. */
export type LegalAction =
  | { readonly kind: 'BASIC_ATTACK'; readonly target: DecisionActionTarget }
  | { readonly kind: 'ABILITY'; readonly abilityId: string; readonly target: DecisionActionTarget }
  | { readonly kind: 'EPIC'; readonly epicId: string; readonly target: DecisionActionTarget }
