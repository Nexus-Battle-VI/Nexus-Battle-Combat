import { InvalidMissionSimulationRequestError } from '../../../application/errors/MissionSimulationIntakeErrors'

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
 * Validates the stable transport envelope sent by Missions. Enemy numbers,
 * strategy feasibility and AI behavior belong to the future engine, not here.
 * In particular, a null enemy profile is accepted while content is undecided.
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
