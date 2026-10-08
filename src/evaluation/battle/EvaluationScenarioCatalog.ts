import {
  createCombatProfile,
  type CombatAbility,
  type CombatAbilityEffect,
  type CombatEpic,
  type CombatMagnitude,
  type CombatProfile,
} from '../../domain/entities/CombatProfile'
import { EVALUATION_SCENARIOS_VERSION, type EvaluationScenario } from './EvaluationScenario'

/**
 * Catalogo de escenarios (EN-036.5, Management #569 §34-38): los datos
 * base (Vida 44/Ataque 10/Defensa 11/Dano 1d6 del "Guerrero Armas", y
 * cada habilidad/epica con su `abilityId`/`epicProductId` real) son
 * EXACTAMENTE los de `test/fixtures/basic-attack.ts`,
 * `test/fixtures/skills.ts` y `test/fixtures/epic.ts` -- auditados, nunca
 * inventados (#569 §35). Se duplican aqui como datos planos en vez de
 * importar `test/fixtures/*` porque `tsconfig.build.json` excluye `test/`
 * del `dist/` que corre el CLI compilado (#569 §155-157): un `import`
 * desde `src/` hacia `test/` compilaria para Jest pero rompería en
 * produccion/CLI.
 *
 * NINGUN escenario inventa una estadistica base nueva (Vida/Ataque/
 * Defensa/Dano): todos reutilizan la MISMA linea base validada
 * (`BASE_PROFILE`); solo varian subtipo, Poder maximo, habilidades y
 * epica -- las dimensiones que #569 §36 realmente pide ("habilidades,
 * diferentes power costs, cooldowns, al menos un caso con épica").
 */

const fixed = (amount: number): CombatMagnitude => ({ mode: 'FIXED', amount })
const dice = (count: number, sides: number): CombatMagnitude => ({ mode: 'DICE', count, sides })

const attackBonus = (magnitude: CombatMagnitude): CombatAbilityEffect => ({
  kind: 'STAT_MODIFIER',
  target: 'SELF',
  statistic: 'ATTACK',
  operation: 'INCREASE',
  magnitude,
  hasActivationCondition: false,
})

const damageBonus = (magnitude: CombatMagnitude): CombatAbilityEffect => ({
  kind: 'STAT_MODIFIER',
  target: 'SELF',
  statistic: 'DAMAGE',
  operation: 'INCREASE',
  magnitude,
  hasActivationCondition: false,
})

const abilityOf = (
  abilityId: string,
  name: string,
  cost: number,
  effects: readonly CombatAbilityEffect[],
): CombatAbility => ({
  abilityId,
  name,
  powerCost: { mode: 'FIXED', amount: cost },
  chargeTurns: 1,
  effects,
})

// Mismos abilityId/epicProductId REALES de test/fixtures/skills.ts y
// test/fixtures/epic.ts (leidos de Catalog el 2026-09-21, #569 §35).
const EMBATE_ID = 'a0480732-c909-477b-b8e7-edf676f556a4'
const STORM_ID = 'a7d5c921-18bd-4730-ae45-b05ecafa4c0b'
const LOTUS_ID = '48701c7f-5b62-45b5-a964-31a36c5baca8'
const FOREST_SONG_FIXED_ID = '122c0f47-a7f0-6095-025f-8dd1bd3ch188'
const EPICA_DANO_ID = '4a2f3e4d-5c6b-4d7e-8f9a-0b1c2d3e4f5a'

/** Embate sangriento (Guerrero Armas, 4 Poder): +2 Ataque, +1 Dano. */
const EMBATE = abilityOf(EMBATE_ID, 'Embate sangriento', 4, [
  attackBonus(fixed(2)),
  damageBonus(fixed(1)),
])

/** Golpe de tormenta (Guerrero Armas, 6 Poder): +(3d6) Ataque, +2 Dano. */
const STORM = abilityOf(STORM_ID, 'Golpe de tormenta', 6, [
  attackBonus(dice(3, 6)),
  damageBonus(fixed(2)),
])

/** Flor de loto (Picaro Veneno, 2 Poder): +(4d8) Dano. */
const LOTUS = abilityOf(LOTUS_ID, 'Flor de loto', 2, [damageBonus(dice(4, 8))])

/** Canto del Bosque, magnitud fija (Chaman, 6 Poder): sana +4 a todo el grupo aliado, 2 turnos. */
const FOREST_SONG_FIXED = abilityOf(FOREST_SONG_FIXED_ID, 'Canto del Bosque', 6, [
  {
    kind: 'STAT_MODIFIER',
    target: 'ALLIED_GROUP',
    statistic: 'HEALING',
    operation: 'INCREASE',
    magnitude: fixed(4),
    durationTurns: 2,
    hasActivationCondition: false,
  },
])

const danoDirectoEffect: CombatAbilityEffect = {
  kind: 'DAMAGE',
  target: 'OPPONENT',
  magnitude: fixed(9),
  hasActivationCondition: false,
}

/** Epica sintetica de dano directo (Guerrero Tanque, Poder 0, recarga 2). */
const EPICA_DANO: CombatEpic = {
  epicProductId: EPICA_DANO_ID,
  epicReference: 'epica-dano',
  name: 'Epica de dano',
  compatibleHeroSubtype: 'GUERRERO_TANQUE',
  powerCost: 0,
  cooldownTurns: 2,
  baseEffect: null,
  specificEffects: [danoDirectoEffect as unknown as Readonly<Record<string, unknown>>],
  applied: {
    baseApplied: null,
    additionalApplied: [danoDirectoEffect as unknown as Readonly<Record<string, unknown>>],
  },
  executableEffects: [danoDirectoEffect],
}

/** Linea base validada (Tabla 6, Guerrero Armas sin equipamiento): Vida 44, Ataque 10, Defensa 11, Dano 1d6. */
const baseProfile = (overrides: Partial<CombatProfile> = {}): CombatProfile =>
  createCombatProfile({
    heroId: overrides.heroId ?? 'hero',
    subtype: overrides.subtype ?? 'GUERRERO_ARMAS',
    maxHealth: 44,
    attack: 10,
    defense: 11,
    damage: dice(1, 6),
    activeEffects: [],
    ...overrides,
  })

const offensiveProfile = (heroId: string): CombatProfile =>
  baseProfile({ heroId, maxPower: 10, abilities: [EMBATE, STORM, LOTUS] })

const supportProfile = (heroId: string): CombatProfile =>
  baseProfile({
    heroId,
    subtype: 'CHAMAN',
    attack: null,
    damage: null,
    maxPower: 10,
    abilities: [FOREST_SONG_FIXED],
  })

const epicOffensiveProfile = (heroId: string): CombatProfile =>
  baseProfile({ heroId, subtype: 'GUERRERO_TANQUE', maxPower: 10, abilities: [], epic: EPICA_DANO })

export const EVALUATION_SCENARIOS: readonly EvaluationScenario[] = [
  {
    scenarioId: 'basic-attack-mirror',
    scenarioVersion: EVALUATION_SCENARIOS_VERSION,
    description:
      'Dos Guerrero Armas sin habilidades ni Poder: solo BASIC_ATTACK disponible en cada turno.',
    teamAProfile: baseProfile({ heroId: 'scenario-basic-attack-mirror-a' }),
    teamBProfile: baseProfile({ heroId: 'scenario-basic-attack-mirror-b' }),
  },
  {
    scenarioId: 'offensive-abilities',
    scenarioVersion: EVALUATION_SCENARIOS_VERSION,
    description:
      'Dos Guerrero Armas con habilidades ofensivas reales (Embate, Tormenta, Loto) y 10 de Poder: ' +
      'la politica elige entre BASIC_ATTACK y varias ABILITY con distinto costo de Poder.',
    teamAProfile: offensiveProfile('scenario-offensive-abilities-a'),
    teamBProfile: offensiveProfile('scenario-offensive-abilities-b'),
  },
  {
    scenarioId: 'support-vs-offensive',
    scenarioVersion: EVALUATION_SCENARIOS_VERSION,
    description:
      'Chaman sin Ataque (Canto del Bosque como unica habilidad) contra un Guerrero Armas ' +
      'ofensivo: ejercita el caso de soporte sin BASIC_ATTACK (#569 §37) y sigue siendo ' +
      'terminable, porque Canto del Bosque (ALLIED_GROUP) siempre es legal con el chaman vivo.',
    teamAProfile: supportProfile('scenario-support-vs-offensive-a'),
    teamBProfile: offensiveProfile('scenario-support-vs-offensive-b'),
  },
  {
    scenarioId: 'epic-vs-offensive',
    scenarioVersion: EVALUATION_SCENARIOS_VERSION,
    description:
      'Guerrero Tanque con una epica de dano directo equipada contra un Guerrero Armas ' +
      'ofensivo: cubre el caso con EPIC disponible como candidata legal (#569 §36).',
    teamAProfile: epicOffensiveProfile('scenario-epic-vs-offensive-a'),
    teamBProfile: offensiveProfile('scenario-epic-vs-offensive-b'),
  },
]
