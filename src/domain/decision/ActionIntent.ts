import type { CombatantKey } from '../entities/Combatant'

/** Elección de una política; no expresa daño, RNG ni estado resultante. */
export type ActionIntent =
  | { readonly kind: 'BASIC_ATTACK'; readonly target: CombatantKey }
  | { readonly kind: 'ABILITY'; readonly abilityId: string; readonly target: CombatantKey }
  | { readonly kind: 'EPIC'; readonly epicId: string; readonly target: CombatantKey | null }
