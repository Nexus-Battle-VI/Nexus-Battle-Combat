import { InvalidMissionSimulationRequestError } from '../../../application/errors/MissionSimulationIntakeErrors'
import type { CombatMagnitude } from '../../../domain/entities/CombatProfile'
import { createCombatProfile } from '../../../domain/entities/CombatProfile'
import type {
  MissionFighter,
  MissionSimulationRequest,
} from '../../../application/services/MissionSimulation'

type JsonObject = Record<string, unknown>

const invalid = (field: string): never => {
  throw new InvalidMissionSimulationRequestError(`${field} no cumple el esquema de simulacion.`)
}

const objectAt = (value: unknown, field: string): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field)
  return value as JsonObject
}

const textAt = (value: unknown, field: string, maxLength = 200): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    invalid(field)
  }
  return value as string
}

const positiveIntegerAt = (value: unknown, field: string): void => {
  if (!Number.isInteger(value) || (value as number) < 1) invalid(field)
}

const optionalFiniteNumberAt = (value: unknown, field: string): void => {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) invalid(field)
}

/**
 * Validates the stable transport envelope sent by Missions. Full combat content
 * is checked separately so an invalid snapshot receives a useful 422 response.
 */
export const missionSimulationOperationIdOf = (body: unknown): string => {
  const request = objectAt(body, 'body')
  if (request.schemaVersion !== 1) invalid('schemaVersion')

  const operationId = textAt(request.operationId, 'operationId', 300)
  textAt(request.enrollmentId, 'enrollmentId')
  textAt(request.missionId, 'missionId')

  if (!['NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC'].includes(String(request.difficulty))) {
    invalid('difficulty')
  }
  optionalFiniteNumberAt(request.enemyStatMultiplier, 'enemyStatMultiplier')
  if (request.enemyStatMultiplier !== null && (request.enemyStatMultiplier as number) <= 0) {
    invalid('enemyStatMultiplier')
  }
  if (
    typeof request.timeBudget !== 'string' ||
    !/^PT(?:(?:[1-9]\d*H(?:[1-9]\d*M)?)|(?:[1-9]\d*M))$/.test(request.timeBudget)
  ) {
    invalid('timeBudget')
  }

  const hero = objectAt(request.hero, 'hero')
  textAt(hero.heroId, 'hero.heroId')
  objectAt(hero.profile, 'hero.profile')

  const strategy = objectAt(request.strategy, 'strategy')
  if (
    strategy.version !== null &&
    (!Number.isInteger(strategy.version) || (strategy.version as number) < 1)
  ) {
    invalid('strategy.version')
  }
  if (strategy.fallback !== 'BASIC_ATTACK') invalid('strategy.fallback')
  if (!Array.isArray(strategy.rotations) || strategy.rotations.length > 3) {
    invalid('strategy.rotations')
  }
  const rotations = strategy.rotations as unknown[]
  for (const [index, raw] of rotations.entries()) {
    const rotationPath = `strategy.rotations[${String(index)}]`
    const rotation = objectAt(raw, rotationPath)
    if (!['HIGH', 'MEDIUM', 'LOW'].includes(String(rotation.priority))) {
      invalid(`${rotationPath}.priority`)
    }
    if (!Array.isArray(rotation.steps) || rotation.steps.length < 1 || rotation.steps.length > 3) {
      invalid(`${rotationPath}.steps`)
    }
    const steps = rotation.steps as unknown[]
    for (const [stepIndex, rawStep] of steps.entries()) {
      const stepPath = `${rotationPath}.steps[${String(stepIndex)}]`
      const step = objectAt(rawStep, stepPath)
      if (step.kind === 'ABILITY') {
        textAt(step.abilityId, `${stepPath}.abilityId`)
      } else if (step.kind !== 'BASIC_ATTACK') {
        invalid(`${stepPath}.kind`)
      }
    }
  }

  if (!Array.isArray(request.encounters) || request.encounters.length < 1) {
    invalid('encounters')
  }
  const encounters = request.encounters as unknown[]
  for (const [index, raw] of encounters.entries()) {
    const encounterPath = `encounters[${String(index)}]`
    const encounter = objectAt(raw, encounterPath)
    positiveIntegerAt(encounter.index, `${encounterPath}.index`)
    if (encounter.kind !== 'REGULAR' && encounter.kind !== 'BOSS') {
      invalid(`${encounterPath}.kind`)
    }
    optionalFiniteNumberAt(encounter.powerStep, `${encounterPath}.powerStep`)
    if (!Array.isArray(encounter.enemies) || encounter.enemies.length < 1) {
      invalid(`${encounterPath}.enemies`)
    }
    const enemies = encounter.enemies as unknown[]
    for (const [enemyIndex, rawEnemy] of enemies.entries()) {
      const enemyPath = `${encounterPath}.enemies[${String(enemyIndex)}]`
      const enemy = objectAt(rawEnemy, enemyPath)
      textAt(enemy.enemyRef, `${enemyPath}.enemyRef`)
      textAt(enemy.name, `${enemyPath}.name`)
      positiveIntegerAt(enemy.count, `${enemyPath}.count`)
      if (enemy.profile !== null) {
        objectAt(enemy.profile, `${enemyPath}.profile`)
      }
    }
  }

  if (request.master !== null) objectAt(request.master, 'master')
  return operationId
}

/** Content can be edited in Missions, so reject an incomplete frozen snapshot explicitly. */
export class MissionSimulationContentError extends Error {
  constructor(field: string) {
    super(`${field} necesita estadisticas de combate completas.`)
    this.name = 'MissionSimulationContentError'
  }
}

const content = (value: unknown, field: string): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MissionSimulationContentError(field)
  }
  return value as JsonObject
}

const integer = (value: unknown, field: string, min = 0, max = 1_000_000): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new MissionSimulationContentError(field)
  }
  return value
}

const fraction = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new MissionSimulationContentError(field)
  }
  return value
}

const magnitude = (value: unknown, field: string): CombatMagnitude => {
  if (typeof value === 'number') return { mode: 'FIXED', amount: integer(value, field) }
  const raw = content(value, field)
  if (raw.mode === 'FIXED') return { mode: 'FIXED', amount: integer(raw.amount, `${field}.amount`) }
  if (raw.mode === 'DICE') {
    return {
      mode: 'DICE',
      count: integer(raw.count, `${field}.count`, 1, 100),
      sides: integer(raw.sides, `${field}.sides`, 2, 8000),
    }
  }
  throw new MissionSimulationContentError(field)
}

const fighter = (value: unknown, field: string): MissionFighter => {
  const raw = content(value, field)
  const ai = raw.ai ?? 'AGGRESSIVE'
  if (typeof ai !== 'string' || !['AGGRESSIVE', 'GUARDED', 'BOSS'].includes(ai)) {
    throw new MissionSimulationContentError(`${field}.ai`)
  }
  return {
    maxHealth: integer(raw.maxHealth ?? raw.health, `${field}.maxHealth`, 1),
    attack: integer(raw.attack, `${field}.attack`),
    defense: integer(raw.defense, `${field}.defense`),
    damage: magnitude(raw.damage, `${field}.damage`),
    ai: ai as MissionFighter['ai'],
    ...(ai === 'BOSS'
      ? {
          enrageBelowPercent: integer(
            raw.enrageBelowPercent ?? 50,
            `${field}.enrageBelowPercent`,
            1,
            100,
          ),
          enrageAttackBonus: integer(raw.enrageAttackBonus ?? 0, `${field}.enrageAttackBonus`),
        }
      : {}),
  }
}

export const missionSimulationRequestOf = (body: unknown): MissionSimulationRequest => {
  missionSimulationOperationIdOf(body)
  const raw = body as JsonObject
  const hero = content(raw.hero, 'hero')
  const profile = content(hero.profile, 'hero.profile')
  const stats = content(profile.effectiveStats, 'hero.profile.effectiveStats')
  if (typeof profile.subtype !== 'string' || profile.subtype.length === 0) {
    throw new MissionSimulationContentError('hero.profile.subtype')
  }
  const attack =
    stats.attack === null ? null : integer(stats.attack, 'hero.profile.effectiveStats.attack')
  const damage =
    stats.damage === null ? null : magnitude(stats.damage, 'hero.profile.effectiveStats.damage')
  if (!Array.isArray(profile.abilities))
    throw new MissionSimulationContentError('hero.profile.abilities')
  const abilities = profile.abilities
  const encounters = (raw.encounters as JsonObject[]).map((encounter, index) => ({
    index: encounter.index as number,
    kind: encounter.kind as 'REGULAR' | 'BOSS',
    powerStep: encounter.powerStep as number | null,
    enemies: (encounter.enemies as JsonObject[]).map((enemy, enemyIndex) => ({
      enemyRef: enemy.enemyRef as string,
      name: enemy.name as string,
      count: enemy.count as number,
      profile: fighter(
        enemy.profile,
        `encounters[${String(index)}].enemies[${String(enemyIndex)}].profile`,
      ),
    })),
  }))
  const masterRaw = raw.master === null ? null : content(raw.master, 'master')
  const candidates = masterRaw?.candidates
  if (
    masterRaw !== null &&
    (!Array.isArray(masterRaw.evaluationPoints) ||
      !Array.isArray(candidates) ||
      candidates.length === 0)
  ) {
    throw new MissionSimulationContentError('master')
  }
  const master =
    masterRaw === null
      ? null
      : {
          evaluationPoints: (masterRaw.evaluationPoints as unknown[]).map((entry, index) => ({
            afterEncounter: integer(
              content(entry, `master.evaluationPoints[${String(index)}]`).afterEncounter,
              'master.evaluationPoints.afterEncounter',
              1,
            ),
          })),
          maxAppearances: integer(masterRaw.maxAppearances, 'master.maxAppearances', 1),
          candidates: (candidates as unknown[]).map((entry, index) => {
            const candidate = content(entry, `master.candidates[${String(index)}]`)
            return {
              masterRef: textAt(
                candidate.masterRef,
                `master.candidates[${String(index)}].masterRef`,
              ),
              subtype: textAt(candidate.subtype, `master.candidates[${String(index)}].subtype`),
              probability: fraction(
                candidate.probability,
                `master.candidates[${String(index)}].probability`,
              ),
              levelOffset: integer(
                candidate.levelOffset,
                `master.candidates[${String(index)}].levelOffset`,
              ),
              profile: fighter(candidate.profile, `master.candidates[${String(index)}].profile`),
              epicRef: textAt(candidate.epicRef, `master.candidates[${String(index)}].epicRef`),
            }
          }),
        }
  const rulesRaw = raw.rules === undefined ? null : content(raw.rules, 'rules')
  if (raw.bossDrops !== undefined && !Array.isArray(raw.bossDrops)) {
    throw new MissionSimulationContentError('bossDrops')
  }
  const bossDrops = (raw.bossDrops as unknown[] | undefined)?.map((entry, index) => {
    const drop = content(entry, `bossDrops[${String(index)}]`)
    const probability = fraction(drop.probability, `bossDrops[${String(index)}].probability`)
    const productId = drop.productId ?? null
    if (
      productId !== null &&
      (typeof productId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          productId,
        ))
    ) {
      throw new MissionSimulationContentError(`bossDrops[${String(index)}].productId`)
    }
    return {
      label: textAt(drop.label, `bossDrops[${String(index)}].label`),
      probability,
      rolls: integer(drop.rolls, `bossDrops[${String(index)}].rolls`, 1, 100),
      productId,
    }
  })
  const rules =
    rulesRaw === null
      ? undefined
      : {
          turnDurationSeconds: integer(
            rulesRaw.turnDurationSeconds,
            'rules.turnDurationSeconds',
            1,
            3600,
          ),
          maxTurnsPerEncounter: integer(
            rulesRaw.maxTurnsPerEncounter,
            'rules.maxTurnsPerEncounter',
            1,
            1000,
          ),
          recoveryPercent: integer(rulesRaw.recoveryPercent, 'rules.recoveryPercent', 0, 100),
          criticalChance: fraction(rulesRaw.criticalChance, 'rules.criticalChance'),
          criticalMultiplier:
            typeof rulesRaw.criticalMultiplier === 'number' &&
            rulesRaw.criticalMultiplier >= 1 &&
            rulesRaw.criticalMultiplier <= 1.8
              ? rulesRaw.criticalMultiplier
              : (() => {
                  throw new MissionSimulationContentError('rules.criticalMultiplier')
                })(),
          ...(rulesRaw.supportAttack === undefined
            ? {}
            : { supportAttack: integer(rulesRaw.supportAttack, 'rules.supportAttack', 0, 100) }),
          ...(rulesRaw.supportDamage === undefined
            ? {}
            : { supportDamage: integer(rulesRaw.supportDamage, 'rules.supportDamage', 0, 100) }),
          ...(rulesRaw.supportRegen === undefined
            ? {}
            : { supportRegen: integer(rulesRaw.supportRegen, 'rules.supportRegen', 0, 100) }),
        }
  const multiplier = raw.enemyStatMultiplier
  if (
    typeof multiplier !== 'number' ||
    !Number.isFinite(multiplier) ||
    multiplier <= 0 ||
    multiplier > 10
  ) {
    throw new MissionSimulationContentError('enemyStatMultiplier')
  }
  const health = integer(stats.health, 'hero.profile.effectiveStats.health', 1)
  const power = integer(stats.power, 'hero.profile.effectiveStats.power')
  const defense = integer(stats.defense, 'hero.profile.effectiveStats.defense')
  let checkedAbilities: MissionSimulationRequest['hero']['profile']['abilities']
  try {
    checkedAbilities =
      createCombatProfile({
        heroId: hero.heroId as string,
        subtype: profile.subtype,
        maxHealth: health,
        maxPower: power,
        attack,
        defense,
        damage,
        activeEffects: [],
        abilities: abilities as MissionSimulationRequest['hero']['profile']['abilities'],
      }).abilities ?? []
  } catch {
    throw new MissionSimulationContentError('hero.profile.abilities')
  }
  return {
    schemaVersion: 1,
    operationId: raw.operationId as string,
    enrollmentId: raw.enrollmentId as string,
    missionId: raw.missionId as string,
    difficulty: raw.difficulty as MissionSimulationRequest['difficulty'],
    enemyStatMultiplier: multiplier,
    timeBudget: raw.timeBudget as string,
    hero: {
      heroId: hero.heroId as string,
      profile: {
        subtype: profile.subtype,
        effectiveStats: {
          health,
          power,
          attack,
          defense,
          damage,
        },
        abilities: checkedAbilities,
      },
    },
    strategy: raw.strategy as MissionSimulationRequest['strategy'],
    encounters,
    ...(rules === undefined ? {} : { rules }),
    ...(bossDrops === undefined ? {} : { bossDrops }),
    master,
  }
}
