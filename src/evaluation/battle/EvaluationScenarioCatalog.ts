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
 * Catalogo de escenarios (EN-036.5, Management #569 §34-38): escenarios
 * CONTROLADOS construidos con perfiles validos de Combat y los MISMOS
 * fixtures que ya usa la suite de pruebas del repo
 * (`test/fixtures/basic-attack.ts`, `skills.ts`, `epic.ts`) -- nunca
 * estadisticas base inventadas (#569 §35). Se duplican aqui como datos
 * planos en vez de importar `test/fixtures/*` porque
 * `tsconfig.build.json` excluye `test/` del `dist/` que corre el CLI
 * compilado (#569 §155-157): un `import` desde `src/` hacia `test/`
 * compilaria para Jest pero rompería en produccion/CLI.
 *
 * Honestidad sobre el origen de cada pieza (correccion de revision: el PR
 * original afirmaba "habilidades/epicas reales" sin distinguir):
 *
 *  - `EMBATE`/`STORM`/`LOTUS`: `abilityId` real de Catalog (leido el
 *    2026-09-21), con su magnitud real (dados incluidos).
 *  - `FOREST_SONG_FIXED`: variante SOLO DE PRUEBA de Canto del Bosque
 *    (`test/fixtures/skills.ts` la documenta asi explicitamente) -- el
 *    Catalog real usa magnitud `2d6`, esta usa una magnitud FIJA para no
 *    depender de la secuencia de dados. Es el mismo `abilityId` real,
 *    pero el EFECTO es la variante de prueba, no el snapshot de Catalog.
 *  - `EPICA_DANO`: epica SINTETICA (`test/fixtures/epic.ts` la llama
 *    literalmente "Épica sintética (prueba)"), nunca una epica real de
 *    Catalog -- se reutiliza aqui porque ya es el fixture validado que la
 *    suite usa para ejercitar daño directo de una epica.
 *  - `CHAMAN`/`GUERRERO_TANQUE` como `subtype`: heredan la MISMA linea
 *    base de Guerrero Armas (Vida 44/Ataque 10/Defensa 11/Dano 1d6) --
 *    NO son las estadisticas reales de esos subtipos en Catalog, son una
 *    etiqueta de presentacion sobre un perfil valido. Ningun escenario
 *    inventa una estadistica base nueva: todos reutilizan `baseProfile`;
 *    solo varian subtipo, Poder maximo, habilidades y epica.
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

// Mismos abilityId/epicProductId de test/fixtures/skills.ts y
// test/fixtures/epic.ts. EMBATE/STORM/LOTUS son abilityId REALES de
// Catalog (leidos el 2026-09-21). FOREST_SONG_FIXED_ID/EPICA_DANO_ID son
// ids de las variantes DE PRUEBA de esos mismos fixtures (ver comentario
// del modulo arriba): nunca se afirma que su EFECTO sea un snapshot
// actual de Catalog.
const EMBATE_ID = 'a0480732-c909-477b-b8e7-edf676f556a4'
/** Exportado para pruebas (#569 §106: regresion de Poder sobre `offensive-abilities`, costo 6). */
export const STORM_ID = 'a7d5c921-18bd-4730-ae45-b05ecafa4c0b'
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

/**
 * Canto del Bosque, variante DE PRUEBA con magnitud fija (6 Poder): sana
 * +4 a todo el grupo aliado, 2 turnos. El Catalog real usa `2d6`; esta
 * magnitud fija es la misma variante que `test/fixtures/skills.ts` usa
 * para no depender de la secuencia de dados -- nunca el snapshot actual
 * de Catalog.
 */
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

/**
 * Epica SINTETICA de dano directo (Poder 0, recarga 2) -- `test/fixtures/
 * epic.ts` la documenta literalmente como "Épica sintética (prueba)",
 * nunca una epica real de Catalog. Se reutiliza tal cual porque ya es el
 * fixture validado que la suite usa para ejercitar daño directo de una
 * epica.
 */
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
      'Soporte sin Ataque (Canto del Bosque, variante de prueba de magnitud fija, como unica ' +
      'habilidad) contra un Guerrero Armas ofensivo: ejercita el caso de soporte sin ' +
      'BASIC_ATTACK (#569 §37) y sigue siendo terminable, porque Canto del Bosque ' +
      '(ALLIED_GROUP) siempre es legal con el soporte vivo.',
    teamAProfile: supportProfile('scenario-support-vs-offensive-a'),
    teamBProfile: offensiveProfile('scenario-support-vs-offensive-b'),
  },
  {
    scenarioId: 'epic-vs-offensive',
    scenarioVersion: EVALUATION_SCENARIOS_VERSION,
    description:
      'Perfil con una epica SINTETICA de dano directo equipada (fixture de prueba, no un ' +
      'snapshot de Catalog) contra un Guerrero Armas ofensivo: cubre el caso con EPIC ' +
      'disponible como candidata legal (#569 §36).',
    teamAProfile: epicOffensiveProfile('scenario-epic-vs-offensive-a'),
    teamBProfile: offensiveProfile('scenario-epic-vs-offensive-b'),
  },
]
