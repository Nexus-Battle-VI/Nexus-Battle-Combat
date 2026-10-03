import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import type {
  CombatAbilityEffect,
  CombatEpic,
  CombatProfile,
} from '../../src/domain/entities/CombatProfile'
import {
  battleWithCombat,
  combatProfileFixture,
  type BattleWithCombatOptions,
} from './basic-attack'
import { fixed } from './skills'

/**
 * Fixtures de la correccion HU-19/HU-31 (tras GAP-HU31-CATALOG-MULTI-EFFECT): epicas
 * equipadas CONGELADAS, con magnitudes FIJAS (sin dados) para que las pruebas de
 * mecanica (turno, Poder, recarga, inmutabilidad) no dependan de la secuencia HU-24.
 */

export const GOLPE_DE_DEFENSA_ID = '3f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f'
export const EPICA_DANO_ID = '4a2f3e4d-5c6b-4d7e-8f9a-0b1c2d3e4f5a'
export const EPICA_SANACION_ID = '5b3f4e5e-6d7c-4e8f-9a0b-1c2d3e4f5a6b'

/** Opaco Y tipado a la vez: lo mismo que viaja en `baseEffect`/`specificEffects` ya es, por
 * construccion, un `CombatAbilityEffect` valido (`executableEffects` reutiliza el MISMO objeto).
 */
const asOpaque = (effect: CombatAbilityEffect): Readonly<Record<string, unknown>> =>
  effect as unknown as Readonly<Record<string, unknown>>

const statEffect = (
  statistic: CombatAbilityEffect['statistic'],
  operation: 'INCREASE' | 'DECREASE',
  amount: number,
  target = 'SELF',
): CombatAbilityEffect => ({
  kind: 'STAT_MODIFIER',
  target,
  statistic,
  operation,
  magnitude: fixed(amount),
  hasActivationCondition: false,
})

const golpeDeDefensaBase = statEffect('DEFENSE', 'INCREASE', 4)
const golpeDeDefensaSpecific1 = statEffect('DAMAGE', 'INCREASE', 4)
const golpeDeDefensaSpecific2 = statEffect('CRITICAL_CHANCE', 'INCREASE', 2)

/**
 * Golpe de defensa (Guerrero Tanque, Tabla 20): +4 Defensa (general) + +4 Dano Y +2%
 * Critico (DOS efectos especificos simultaneos, GAP-HU31-CATALOG-MULTI-EFFECT). Todo
 * SELF: ningun objetivo necesario.
 */
export const GOLPE_DE_DEFENSA_EPIC: CombatEpic = {
  epicProductId: GOLPE_DE_DEFENSA_ID,
  epicReference: 'golpe-de-defensa',
  name: 'Golpe de defensa',
  compatibleHeroSubtype: 'GUERRERO_TANQUE',
  powerCost: 0,
  cooldownTurns: 2,
  baseEffect: asOpaque(golpeDeDefensaBase),
  specificEffects: [asOpaque(golpeDeDefensaSpecific1), asOpaque(golpeDeDefensaSpecific2)],
  applied: {
    baseApplied: asOpaque(golpeDeDefensaBase),
    additionalApplied: [asOpaque(golpeDeDefensaSpecific1), asOpaque(golpeDeDefensaSpecific2)],
  },
  executableEffects: [golpeDeDefensaBase, golpeDeDefensaSpecific1, golpeDeDefensaSpecific2],
}

/** La MISMA definicion, pero con el subtipo del heroe NO coincidente: solo el general. */
export const GOLPE_DE_DEFENSA_SIN_MATCH_EPIC: CombatEpic = {
  ...GOLPE_DE_DEFENSA_EPIC,
  applied: { baseApplied: asOpaque(golpeDeDefensaBase), additionalApplied: [] },
  executableEffects: [golpeDeDefensaBase],
}

const danoDirecto: CombatAbilityEffect = {
  kind: 'DAMAGE',
  target: 'OPPONENT',
  magnitude: fixed(9),
  hasActivationCondition: false,
}

/** Epica sintetica con un efecto `DAMAGE` directo sobre el rival (prueba T-C de dano). */
export const EPICA_DANO: CombatEpic = {
  epicProductId: EPICA_DANO_ID,
  epicReference: 'epica-dano',
  name: 'Epica de dano (prueba)',
  compatibleHeroSubtype: 'GUERRERO_TANQUE',
  powerCost: 0,
  cooldownTurns: 2,
  baseEffect: null,
  specificEffects: [asOpaque(danoDirecto)],
  applied: { baseApplied: null, additionalApplied: [asOpaque(danoDirecto)] },
  executableEffects: [danoDirecto],
}

const sanacionInstantanea: CombatAbilityEffect = {
  kind: 'STAT_MODIFIER',
  target: 'ALLIED_GROUP',
  statistic: 'HEALING',
  operation: 'INCREASE',
  magnitude: fixed(6),
  hasActivationCondition: false,
}

/** Epica sintetica con sanacion instantanea de grupo (prueba T-C de sanacion). */
export const EPICA_SANACION: CombatEpic = {
  epicProductId: EPICA_SANACION_ID,
  epicReference: 'epica-sanacion',
  name: 'Epica de sanacion (prueba)',
  compatibleHeroSubtype: 'CHAMAN',
  powerCost: 0,
  cooldownTurns: 2,
  baseEffect: null,
  specificEffects: [asOpaque(sanacionInstantanea)],
  applied: { baseApplied: null, additionalApplied: [asOpaque(sanacionInstantanea)] },
  executableEffects: [sanacionInstantanea],
}

/** Perfil con Poder/habilidades congelados (igual que `skillProfile`) MAS la epica indicada. */
export const epicProfile = (
  epic: CombatEpic | undefined,
  overrides: Partial<CombatProfile> = {},
): CombatProfile =>
  combatProfileFixture({
    maxPower: 10,
    abilities: [],
    ...(epic === undefined ? {} : { epic }),
    ...overrides,
  })

/**
 * Sala `IN_BATTLE` 1v1 (o la indicada) donde `a1` y `b1` llevan Poder y la epica congelados.
 * `epic` es OBLIGATORIO (sin valor por defecto a proposito): un default activado por
 * `undefined` haria indistinguible "usa Golpe de defensa" de "sin epica equipada", justo lo
 * que CMB-07 necesita poder expresar.
 */
export const battleWithEpic = (
  epic: CombatEpic | undefined,
  options: BattleWithCombatOptions = {},
): BattleRoom =>
  battleWithCombat({
    profiles: { a1: epicProfile(epic), b1: epicProfile(epic) },
    ...options,
  })
