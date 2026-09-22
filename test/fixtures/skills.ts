import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import type {
  CombatAbility,
  CombatAbilityEffect,
  CombatMagnitude,
  CombatProfile,
} from '../../src/domain/entities/CombatProfile'
import {
  battleWithCombat,
  combatProfileFixture,
  type BattleWithCombatOptions,
} from './basic-attack'

/**
 * Fixtures de HU-19 (habilidades especiales): habilidades de la Tabla 7 tal como el Catalog
 * desplegado las publica (leidas por su API publica el 2026-09-21), y salas EN BATALLA cuyos
 * participantes llevan Poder y habilidades congelados.
 */
export const fixed = (amount: number): CombatMagnitude => ({ mode: 'FIXED', amount })
export const dice = (count: number, sides: number): CombatMagnitude => ({
  mode: 'DICE',
  count,
  sides,
})

/** `+N` (o `+NdM`) al Ataque propio: el unico patron de ataque soportado. */
export const attackBonus = (magnitude: CombatMagnitude): CombatAbilityEffect => ({
  kind: 'STAT_MODIFIER',
  target: 'SELF',
  statistic: 'ATTACK',
  operation: 'INCREASE',
  magnitude,
  hasActivationCondition: false,
})

/** `+N` (o `+NdM`) al Dano propio. */
export const damageBonus = (magnitude: CombatMagnitude): CombatAbilityEffect => ({
  kind: 'STAT_MODIFIER',
  target: 'SELF',
  statistic: 'DAMAGE',
  operation: 'INCREASE',
  magnitude,
  hasActivationCondition: false,
})

export const SHIELD_STRIKE_ID = '2e97537a-675c-461a-b902-4fcf369083a8'
export const EMBATE_ID = 'a0480732-c909-477b-b8e7-edf676f556a4'
export const STORM_ID = 'a7d5c921-18bd-4730-ae45-b05ecafa4c0b'
export const LOTUS_ID = '48701c7f-5b62-45b5-a964-31a36c5baca8'
export const STONE_HAND_ID = '6c2bac06-0dc2-4a63-a526-a3adca2200d7'
export const REANIMATE_ID = '48e80ca7-8fe7-499b-9784-78d857ba5300'

const abilityOf = (
  abilityId: string,
  name: string,
  cost: number,
  effects: readonly CombatAbilityEffect[],
  chargeTurns = 1,
): CombatAbility => ({
  abilityId,
  name,
  powerCost: { mode: 'FIXED', amount: cost },
  chargeTurns,
  effects,
})

/** Golpe con escudo (Guerrero Tanque, 2 de Poder): +2 al Ataque. */
export const SHIELD_STRIKE = abilityOf(SHIELD_STRIKE_ID, 'Golpe con escudo', 2, [
  attackBonus(fixed(2)),
])

/** Embate sangriento (Guerrero Armas, 4): +2 al Ataque y +1 al Dano. */
export const EMBATE = abilityOf(EMBATE_ID, 'Embate sangriento', 4, [
  attackBonus(fixed(2)),
  damageBonus(fixed(1)),
])

/** Golpe de tormenta (Guerrero Armas, 6): +(3d6) al Ataque y +2 al Dano. */
export const STORM = abilityOf(STORM_ID, 'Golpe de tormenta', 6, [
  attackBonus(dice(3, 6)),
  damageBonus(fixed(2)),
])

/** Flor de loto (Pícaro Veneno, 2): +(4d8) al Dano. */
export const LOTUS = abilityOf(LOTUS_ID, 'Flor de loto', 2, [damageBonus(dice(4, 8))])

/** Mano de piedra (Guerrero Tanque, 4): +12 a la Defensa con duracion y condicion: NO soportada. */
export const STONE_HAND = abilityOf(STONE_HAND_ID, 'Mano de piedra', 4, [
  {
    kind: 'STAT_MODIFIER',
    target: 'SELF',
    statistic: 'DEFENSE',
    operation: 'INCREASE',
    magnitude: fixed(12),
    durationTurns: 2,
    hasActivationCondition: true,
  },
])

/**
 * Reanimacion (Medico): reanima a un aliado; el documento dice «todos los puntos
 * de poder». SOPORTADA (excepcion de curacion de HU-12, sin Task de Management).
 */
export const REANIMATE: CombatAbility = {
  abilityId: REANIMATE_ID,
  name: 'Reanimacion',
  powerCost: { mode: 'ALL_AVAILABLE' },
  chargeTurns: 1,
  effects: [
    {
      kind: 'REVIVE',
      target: 'ALLY',
      magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
      hasActivationCondition: false,
    },
  ],
}

/** Perfil por defecto de HU-19: el de HU-18 (Guerrero Armas) con 10 de Poder y cinco habilidades. */
export const skillProfile = (overrides: Partial<CombatProfile> = {}): CombatProfile =>
  combatProfileFixture({
    maxPower: 10,
    abilities: [SHIELD_STRIKE, EMBATE, STORM, LOTUS, STONE_HAND],
    ...overrides,
  })

/** Sala `IN_BATTLE` 1v1 (o la indicada) donde `a1` y `b1` llevan Poder y habilidades congelados. */
export const battleWithSkills = (options: BattleWithCombatOptions = {}): BattleRoom =>
  battleWithCombat({ profiles: { a1: skillProfile(), b1: skillProfile() }, ...options })
