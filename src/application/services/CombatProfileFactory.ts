import type { CombatMagnitude, CombatProfile } from '../../domain/entities/CombatProfile'
import type { EquippedHero, EquippedHeroMagnitude } from '../ports/PlayerInventoryEquippedHeroPort'

const copyMagnitude = (magnitude: EquippedHeroMagnitude): CombatMagnitude => ({ ...magnitude })

/**
 * Del heroe equipado que Player-Inventory publica al iniciar a su perfil de combate
 * LOCAL y minimo (HU-18). Copia solo lo que HU-20 y el dano necesitan: la Vida
 * maxima, Ataque, Defensa, Dano y los efectos. NO copia el inventario, el nombre, la
 * referencia del heroe, la fecha de seleccion, `baseStats`, el Poder ni el `ready`.
 *
 * No valida ni corrige: los enteros los comprueba `createCombatProfile` al congelarlo.
 */
export const combatProfileFrom = (hero: EquippedHero): CombatProfile => ({
  heroId: hero.heroId,
  subtype: hero.subtype,
  maxHealth: hero.effectiveStats.health,
  attack: hero.effectiveStats.attack,
  defense: hero.effectiveStats.defense,
  damage: hero.effectiveStats.damage === null ? null : copyMagnitude(hero.effectiveStats.damage),
  activeEffects: hero.activeEffects.map((effect) => ({
    sourceProductId: effect.sourceProductId,
    sourceProductReference: effect.sourceProductReference,
    kind: effect.kind,
    target: effect.target,
    ...(effect.statistic === undefined ? {} : { statistic: effect.statistic }),
    ...(effect.operation === undefined ? {} : { operation: effect.operation }),
    ...(effect.magnitude === undefined ? {} : { magnitude: copyMagnitude(effect.magnitude) }),
    ...(effect.durationTurns === undefined ? {} : { durationTurns: effect.durationTurns }),
    hasActivationCondition: effect.hasActivationCondition,
    appliedToStats: effect.appliedToStats,
  })),
})
