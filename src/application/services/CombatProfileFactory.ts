import type {
  CombatAbility,
  CombatAbilityEffect,
  CombatMagnitude,
  CombatProfile,
} from '../../domain/entities/CombatProfile'
import type {
  EquippedHero,
  EquippedHeroAbility,
  EquippedHeroAbilityEffect,
  EquippedHeroMagnitude,
} from '../ports/PlayerInventoryEquippedHeroPort'

const copyMagnitude = (magnitude: EquippedHeroMagnitude): CombatMagnitude => ({ ...magnitude })

const copyAbilityEffect = (effect: EquippedHeroAbilityEffect): CombatAbilityEffect => ({
  kind: effect.kind,
  target: effect.target,
  ...(effect.statistic === undefined ? {} : { statistic: effect.statistic }),
  ...(effect.operation === undefined ? {} : { operation: effect.operation }),
  ...(effect.magnitude === undefined ? {} : { magnitude: copyMagnitude(effect.magnitude) }),
  ...(effect.durationTurns === undefined ? {} : { durationTurns: effect.durationTurns }),
  hasActivationCondition: effect.hasActivationCondition,
})

/** La `reference` (alias) es solo trazabilidad de Player-Inventory: no se congela. */
const copyAbility = (ability: EquippedHeroAbility): CombatAbility => ({
  abilityId: ability.abilityId,
  name: ability.name,
  powerCost: { ...ability.powerCost },
  chargeTurns: ability.chargeTurns,
  effects: ability.effects.map(copyAbilityEffect),
})

/**
 * Del heroe equipado que Player-Inventory publica al iniciar a su perfil de combate
 * LOCAL y minimo (HU-18, HU-19). Copia solo lo que HU-20, el dano y las habilidades
 * necesitan: la Vida maxima, Ataque, Defensa, Dano, los efectos, el Poder maximo y las
 * habilidades. NO copia el inventario, el nombre, la referencia del heroe, la fecha de
 * seleccion, `baseStats` ni el `ready`.
 *
 * El Poder maximo es `maxPower` (`effectiveStats.power`, HU-11): el parser lo deriva de
 * ahi, asi que los dos valen lo mismo por construccion.
 *
 * No valida ni corrige: los enteros y la forma de las habilidades los comprueba
 * `createCombatProfile` al congelarlo.
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
  maxPower: hero.maxPower,
  abilities: hero.abilities.map(copyAbility),
})
