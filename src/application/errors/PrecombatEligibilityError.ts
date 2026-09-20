import type { PrecombatEligibilityBlocker } from '../../domain/policies/PrecombatEligibilityPolicy'

/**
 * HU-16 (RF-16, Management#25/#401/#402). El jugador SI tiene un heroe
 * equipado (a diferencia de `PlayerWithoutEquippedHeroError`), pero
 * `PrecombatEligibilityPolicy` determino que no puede usarse para ESTA sala
 * concreta: Player-Inventory lo declaro no listo (`ready=false`, motivos
 * reenviados sin traducir) y/o su subtipo no puede participar en el formato
 * derivado de la sala (Chaman/Medico en 1 contra 1, DP-5).
 *
 * 422: la peticion de union es sintacticamente correcta; una precondicion de
 * negocio sobre ESE heroe para ESTA sala no se cumple.
 *
 * `blockers` viaja COMPLETO, no colapsado a un unico `code` de nivel
 * superior: pueden concurrir varios motivos a la vez (p. ej. no listo Y
 * clase no permitida), mismo criterio que `HeroReadiness.blockers[].code`
 * de Player-Inventory.
 */
export class PrecombatEligibilityBlockedError extends Error {
  readonly playerId: string
  readonly blockers: readonly PrecombatEligibilityBlocker[]

  constructor(playerId: string, blockers: readonly PrecombatEligibilityBlocker[]) {
    super(`El heroe equipado del jugador "${playerId}" no es elegible para esta sala.`)
    this.name = 'PrecombatEligibilityBlockedError'
    this.playerId = playerId
    this.blockers = blockers
  }
}
