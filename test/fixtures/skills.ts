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
 * HU-19 v2 (contrato §1). `+N`/`-N` (o dados) a una estadistica de OTRO combatiente, o a la
 * propia con duracion: crea un efecto temporal de batalla (contrato §2).
 */
export const statEffect = (
  statistic: string,
  magnitude: CombatMagnitude,
  extra: Partial<CombatAbilityEffect> = {},
  target = 'SELF',
): CombatAbilityEffect => ({
  kind: 'STAT_MODIFIER',
  target,
  statistic,
  operation: 'INCREASE',
  magnitude,
  hasActivationCondition: false,
  ...extra,
})

/** `+N` (o `+NdM`) de Sanacion sobre un aliado o el grupo aliado (HU-19 v2, contrato §1). */
export const healBonus = (
  magnitude: CombatMagnitude,
  extra: Partial<CombatAbilityEffect> = {},
  target = 'ALLY',
): CombatAbilityEffect => statEffect('HEALING', magnitude, extra, target)

export const STONE_FIST_ID = 'a5d8a5f0-30f9-4a2e-9b3e-1f6b5b6c9a11'
export const ICE_CONE_ID = 'b6e9b6f1-41fa-4b3f-ac4f-2a7c6c7dab22'
export const AGONY_ID = 'c7fac7a2-52ab-4c40-bd5a-3b8d7d8ebc33'
export const FIRE_WARD_ID = 'd80adb03-63bc-4d51-ce6b-4c9e8e9fcd44'
export const LIFE_TOUCH_ID = 'e91bec14-74cd-4e62-df7c-5daf9fa0de55'
export const FOREST_SONG_ID = 'fa2cfd25-85de-4f73-e08d-6ebfab1baf66'

/** Mano de piedra (v2, Catalog real): +12 a la Defensa propia, sin duracion ni condicion. SOPORTADA. */
export const STONE_FIST = abilityOf(STONE_FIST_ID, 'Mano de piedra', 3, [
  statEffect('DEFENSE', fixed(12)),
])

/**
 * Cono de hielo (v2, Catalog real): +2 al Dano propio (esta resolucion) y -(1d3) al Ataque del
 * rival durante 2 de sus turnos propios (efecto temporal, contrato §2). SOPORTADA.
 */
export const ICE_CONE = abilityOf(ICE_CONE_ID, 'Cono de hielo', 5, [
  statEffect('DAMAGE', fixed(2)),
  statEffect('ATTACK', dice(1, 3), { operation: 'DECREASE', durationTurns: 2 }, 'OPPONENT'),
])

/** Agonia (v2, Catalog real): dano directo (2d9) sobre el rival, sin resolucion de Ataque/Defensa. SOPORTADA. */
export const AGONY = abilityOf(AGONY_ID, 'Agonia', 3, [
  { kind: 'DAMAGE', target: 'OPPONENT', magnitude: dice(2, 9), hasActivationCondition: false },
])

/**
 * Pare de fuego (v2, Catalog real): +1 al Ataque propio y refleja el 100% del dano recibido en
 * el turno propio anterior (contrato §6). `SUPPORTED_UNCONFIRMED_MAGNITUDE`.
 */
export const FIRE_WARD = abilityOf(FIRE_WARD_ID, 'Pare de fuego', 4, [
  statEffect('ATTACK', fixed(1)),
  {
    kind: 'REFLECT_DAMAGE',
    target: 'OPPONENT',
    magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
    hasActivationCondition: true,
  },
])

/** Toque de la Vida (v2, Catalog real): sana +2 de Vida a un aliado, instantaneo. SOPORTADA. */
export const LIFE_TOUCH = abilityOf(LIFE_TOUCH_ID, 'Toque de la Vida', 3, [healBonus(fixed(2))])

/**
 * Canto del Bosque (v2, Catalog real): sana (2d6) al grupo aliado completo durante 2 de los
 * turnos propios de CADA afectado (efecto temporal de grupo, contrato §2 y §4). SOPORTADA.
 */
export const FOREST_SONG = abilityOf(FOREST_SONG_ID, 'Canto del Bosque', 6, [
  healBonus(dice(2, 6), { durationTurns: 2 }, 'ALLIED_GROUP'),
])

// Variantes de magnitud FIJA de las mismas habilidades, SOLO para pruebas que ejercitan el
// mecanismo generico (persistencia, decremento, idempotencia, ALLIED_GROUP) sin necesitar
// calcular indices de dados: la magnitud no es lo que se prueba ahi.
export const ICE_CONE_FIXED_ID = '011bfe36-96ef-5f84-f19e-7fc0ac2bg077'
export const FOREST_SONG_FIXED_ID = '122c0f47-a7f0-6095-025f-8dd1bd3ch188'
export const AGONY_FIXED_ID = '233d1058-b801-7106-136a-9ee2ce4di299'

export const AGONY_FIXED = abilityOf(AGONY_FIXED_ID, 'Agonia', 3, [
  { kind: 'DAMAGE', target: 'OPPONENT', magnitude: fixed(7), hasActivationCondition: false },
])

export const ICE_CONE_FIXED = abilityOf(ICE_CONE_FIXED_ID, 'Cono de hielo', 5, [
  statEffect('DAMAGE', fixed(2)),
  statEffect('ATTACK', fixed(3), { operation: 'DECREASE', durationTurns: 2 }, 'OPPONENT'),
])

export const FOREST_SONG_FIXED = abilityOf(FOREST_SONG_FIXED_ID, 'Canto del Bosque', 6, [
  healBonus(fixed(4), { durationTurns: 2 }, 'ALLIED_GROUP'),
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
