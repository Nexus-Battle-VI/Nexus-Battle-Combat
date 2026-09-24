import type { RandomSequenceFactoryPort } from '../ports/RandomSequencePort'
import type { MissionSeed } from '../ports/MissionSeedPort'
import { createBoundedRandom } from './BoundedRandom'
import { calculateDamage } from '../../domain/policies/BasicAttackDamagePolicy'
import { dieFaceFromIndex } from '../../domain/policies/AttackProfile'
import { evaluateSkill } from '../../domain/policies/SkillEffectPolicy'
import type { CombatAbility, CombatMagnitude } from '../../domain/entities/CombatProfile'
import { RandomSeed } from '../../domain/value-objects/RandomSeed'

export interface MissionFighter {
  readonly maxHealth: number
  readonly attack: number
  readonly defense: number
  readonly damage: CombatMagnitude
  readonly ai?: 'AGGRESSIVE' | 'GUARDED' | 'BOSS'
  readonly enrageBelowPercent?: number
  readonly enrageAttackBonus?: number
}

export interface MissionSimulationRequest {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly enrollmentId: string
  readonly missionId: string
  readonly difficulty: 'NORMAL' | 'HEROIC' | 'LEGENDARY' | 'MYTHIC'
  readonly enemyStatMultiplier: number
  readonly timeBudget: string
  readonly hero: {
    readonly heroId: string
    readonly profile: {
      readonly name?: string
      readonly subtype: string
      readonly effectiveStats: {
        readonly health: number
        readonly power: number
        readonly attack: number | null
        readonly defense: number
        readonly damage: CombatMagnitude | null
      }
      readonly abilities: readonly CombatAbility[]
    }
  }
  readonly strategy: {
    readonly version: number | null
    readonly rotations: readonly {
      readonly priority: 'HIGH' | 'MEDIUM' | 'LOW'
      readonly steps: readonly {
        readonly kind: 'BASIC_ATTACK' | 'ABILITY'
        readonly abilityId?: string
      }[]
    }[]
    readonly fallback: 'BASIC_ATTACK'
  }
  readonly encounters: readonly {
    readonly index: number
    readonly kind: 'REGULAR' | 'BOSS'
    readonly powerStep: number | null
    readonly enemies: readonly {
      readonly enemyRef: string
      readonly name: string
      readonly count: number
      readonly profile: MissionFighter
    }[]
  }[]
  readonly rules?: {
    readonly turnDurationSeconds: number
    readonly maxTurnsPerEncounter: number
    readonly recoveryPercent: number
    readonly criticalChance: number
    readonly criticalMultiplier: number
    readonly supportAttack?: number
    readonly supportDamage?: number
    readonly supportRegen?: number
  }
  readonly bossDrops?: readonly {
    readonly label: string
    readonly probability: number
    readonly rolls: number
    readonly productId: string | null
  }[]
  readonly master: null | {
    readonly evaluationPoints: readonly { readonly afterEncounter: number }[]
    readonly maxAppearances: number
    readonly candidates: readonly {
      readonly masterRef: string
      readonly subtype: string
      readonly probability: number
      readonly levelOffset: number
      readonly profile: MissionFighter
      readonly epicRef: string
    }[]
  }
}

export interface MissionSimulationResult {
  readonly simulationId: string
  readonly operationId: string
  readonly seedRef: string
  readonly combatOutcome: 'HERO_VICTORIOUS' | 'HERO_DEFEATED' | 'TIME_BUDGET_EXHAUSTED'
  readonly summary: Readonly<Record<string, unknown>>
  readonly combatLog: readonly Readonly<Record<string, unknown>>[]
}

const DEFAULT_RULES = {
  turnDurationSeconds: 60,
  maxTurnsPerEncounter: 30,
  recoveryPercent: 35,
  criticalChance: 0.1,
  criticalMultiplier: 1.5,
} as const

/** A fixed request and operation produce the same private sequence on every replica. */
export const simulateMission = (
  request: MissionSimulationRequest,
  seed: MissionSeed,
  sequences: RandomSequenceFactoryPort,
): MissionSimulationResult => {
  const sequence = sequences.create(RandomSeed.create(seed.value))
  const random = createBoundedRandom(sequence)
  const rules: NonNullable<MissionSimulationRequest['rules']> = request.rules ?? DEFAULT_RULES
  const heroStats = request.hero.profile.effectiveStats
  const supportHero = heroStats.attack === null || heroStats.damage === null
  const heroAttack = heroStats.attack ?? rules.supportAttack ?? 10
  const heroDamage = heroStats.damage ?? { mode: 'FIXED', amount: rules.supportDamage ?? 3 }
  const maxHealth = heroStats.health
  let health = maxHealth
  let power = heroStats.power
  let minHealth = maxHealth
  let elapsedSeconds = 0
  let totalTurns = 0
  let completed = 0
  let bossDefeated = false
  let damageDealt = 0
  let damageTaken = 0
  let criticalEffects = 0
  let outcome: MissionSimulationResult['combatOutcome'] = 'HERO_VICTORIOUS'
  const defeated = new Map<string, number>()
  const skillsUsed = new Map<string, number>()
  const log: Readonly<Record<string, unknown>>[] = []
  const evaluations: { afterEncounter: number; masterRef: string; appeared: boolean }[] = []
  const masterFights: {
    afterEncounter: number
    masterRef: string
    levelOffset: number
    outcome: 'DEFEATED' | 'HERO_DEFEATED' | 'ESCAPED'
    turns: number
  }[] = []
  const cooldowns = new Map<string, number>()
  const cursors = new Map<number, number>()
  const abilities = new Map(
    request.hero.profile.abilities.map((ability) => [ability.abilityId, ability]),
  )

  const event = (type: string, data: Readonly<Record<string, unknown>>): void => {
    log.push({ seq: log.length + 1, type, ...data })
  }
  const roll = (sides: number): number => dieFaceFromIndex(sequence.nextIndex(), sides)
  const magnitude = (value: CombatMagnitude): number => {
    if (value.mode === 'FIXED') return value.amount
    if (value.mode === 'DICE') {
      let result = 0
      for (let n = 0; n < value.count; n += 1) result += roll(value.sides)
      return result
    }
    return 0
  }
  const bonus = (value: {
    readonly fixed: number
    readonly dice: readonly { readonly count: number; readonly sides: number }[]
  }): number =>
    value.fixed +
    value.dice.reduce((sum, die) => {
      let rolled = 0
      for (let n = 0; n < die.count; n += 1) rolled += roll(die.sides)
      return sum + rolled
    }, 0)
  const chooseAction = (): {
    readonly kind: 'BASIC_ATTACK' | 'ABILITY'
    readonly ability?: CombatAbility
  } => {
    const priority = { HIGH: 0, MEDIUM: 1, LOW: 2 }
    const rotations = [...request.strategy.rotations].sort(
      (a, b) => priority[a.priority] - priority[b.priority],
    )
    for (const [index, rotation] of rotations.entries()) {
      for (let offset = 0; offset < rotation.steps.length; offset += 1) {
        const cursor = (cursors.get(index) ?? 0) + offset
        const step = rotation.steps[cursor % rotation.steps.length]
        if (step?.kind === 'BASIC_ATTACK') {
          cursors.set(index, cursor + 1)
          return { kind: 'BASIC_ATTACK' }
        }
        const ability = step?.abilityId === undefined ? undefined : abilities.get(step.abilityId)
        if (ability === undefined || (cooldowns.get(ability.abilityId) ?? 0) > 0) continue
        const support = evaluateSkill(ability)
        const cost = ability.powerCost.mode === 'ALL_AVAILABLE' ? power : ability.powerCost.amount
        if (!support.supported || support.kind !== 'DAMAGE' || cost > power || cost <= 0) continue
        cursors.set(index, cursor + 1)
        return { kind: 'ABILITY', ability }
      }
    }
    return { kind: 'BASIC_ATTACK' }
  }
  const fight = (
    enemyRef: string,
    base: MissionFighter,
    multiplier: number,
    maxTurns: number,
  ): { readonly status: 'DEFEATED' | 'HERO_DEFEATED' | 'ESCAPED'; readonly turns: number } => {
    const enemy = {
      maxHealth: Math.max(1, Math.ceil(base.maxHealth * multiplier)),
      attack: Math.ceil(base.attack * multiplier),
      defense: Math.ceil(base.defense * multiplier),
      damage: base.damage,
    }
    let enemyHealth = enemy.maxHealth
    let guard = 0
    let turns = 0
    event('enemyStarted', { enemyRef, maxHealth: enemy.maxHealth })
    while (enemyHealth > 0 && health > 0) {
      if (
        turns >= maxTurns ||
        elapsedSeconds + rules.turnDurationSeconds > durationSeconds(request.timeBudget)
      ) {
        return { status: 'ESCAPED', turns }
      }
      turns += 1
      totalTurns += 1
      elapsedSeconds += rules.turnDurationSeconds
      if (supportHero) health = Math.min(maxHealth, health + (rules.supportRegen ?? 1))
      for (const [id, remaining] of cooldowns) cooldowns.set(id, Math.max(0, remaining - 1))
      power = Math.min(heroStats.power, power + 2)
      const action = chooseAction()
      let attackBonus = 0
      let damageBonus = 0
      if (action.kind === 'ABILITY' && action.ability !== undefined) {
        const support = evaluateSkill(action.ability)
        if (support.supported && support.kind === 'DAMAGE') {
          attackBonus = bonus(support.attackBonus)
          damageBonus = bonus(support.damageBonus)
          const cost =
            action.ability.powerCost.mode === 'ALL_AVAILABLE'
              ? power
              : action.ability.powerCost.amount
          power -= cost
          cooldowns.set(action.ability.abilityId, action.ability.chargeTurns + 1)
          skillsUsed.set(
            action.ability.abilityId,
            (skillsUsed.get(action.ability.abilityId) ?? 0) + 1,
          )
        }
      }
      const hit = heroAttack + attackBonus + roll(20) >= enemy.defense + guard + 10
      guard = 0
      let dealt = 0
      let critical = false
      if (hit) {
        critical = random.nextInt(8000) < Math.floor(rules.criticalChance * 8000)
        const baseDamage = magnitude(heroDamage) + damageBonus
        dealt = Math.min(
          enemyHealth,
          Math.max(
            1,
            calculateDamage(
              baseDamage,
              critical ? Math.round(rules.criticalMultiplier * 100) : 100,
            ),
          ),
        )
        enemyHealth -= dealt
        damageDealt += dealt
        if (critical) criticalEffects += 1
      }
      event('heroAction', {
        enemyRef,
        action: action.kind,
        abilityId: action.ability?.abilityId ?? null,
        hit,
        damage: dealt,
        critical,
        enemyHealth,
      })
      if (enemyHealth === 0) break
      if (base.ai === 'GUARDED' && turns % 3 === 0) {
        guard = 4
        event('enemyGuarded', { enemyRef, defenseBonus: guard })
        continue
      }
      const enraged =
        base.ai === 'BOSS' && enemyHealth * 100 <= enemy.maxHealth * (base.enrageBelowPercent ?? 50)
      const enemyAttack = enemy.attack + (enraged ? (base.enrageAttackBonus ?? 0) : 0)
      const enemyHit = enemyAttack + roll(20) >= heroStats.defense + 10
      const taken = enemyHit ? Math.min(health, Math.max(1, magnitude(enemy.damage))) : 0
      health -= taken
      damageTaken += taken
      minHealth = Math.min(minHealth, health)
      event('enemyAction', { enemyRef, hit: enemyHit, damage: taken, heroHealth: health, enraged })
    }
    if (health === 0) return { status: 'HERO_DEFEATED', turns }
    defeated.set(enemyRef, (defeated.get(enemyRef) ?? 0) + 1)
    event('enemyDefeated', { enemyRef, turns })
    return { status: 'DEFEATED', turns }
  }

  for (const encounter of request.encounters) {
    event('encounterStarted', { encounter: encounter.index, kind: encounter.kind })
    let encounterTurns = 0
    for (const enemy of encounter.enemies) {
      for (let n = 0; n < enemy.count; n += 1) {
        const result = fight(
          enemy.enemyRef,
          enemy.profile,
          request.enemyStatMultiplier * (1 + (encounter.powerStep ?? 0)),
          rules.maxTurnsPerEncounter - encounterTurns,
        )
        encounterTurns += result.turns
        if (result.status !== 'DEFEATED') {
          outcome = result.status === 'HERO_DEFEATED' ? 'HERO_DEFEATED' : 'TIME_BUDGET_EXHAUSTED'
          break
        }
      }
      if (outcome !== 'HERO_VICTORIOUS') break
    }
    if (outcome !== 'HERO_VICTORIOUS') break
    completed += 1
    if (encounter.kind === 'BOSS') bossDefeated = true
    event('encounterFinished', { encounter: encounter.index, heroHealth: health })
    if (request.master !== null && masterFights.length < request.master.maxAppearances) {
      for (const point of request.master.evaluationPoints.filter(
        (entry) => entry.afterEncounter === encounter.index,
      )) {
        for (const candidate of request.master.candidates) {
          const appeared = random.nextInt(8000) < Math.floor(candidate.probability * 8000)
          evaluations.push({
            afterEncounter: point.afterEncounter,
            masterRef: candidate.masterRef,
            appeared,
          })
          if (!appeared) continue
          const result = fight(
            candidate.masterRef,
            candidate.profile,
            1,
            rules.maxTurnsPerEncounter,
          )
          masterFights.push({
            afterEncounter: point.afterEncounter,
            masterRef: candidate.masterRef,
            levelOffset: candidate.levelOffset,
            outcome: result.status,
            turns: result.turns,
          })
          if (result.status !== 'DEFEATED')
            outcome = result.status === 'HERO_DEFEATED' ? 'HERO_DEFEATED' : 'TIME_BUDGET_EXHAUSTED'
          break
        }
      }
    }
    if (outcome !== 'HERO_VICTORIOUS') break
    if (encounter.kind !== 'BOSS') {
      health = Math.min(maxHealth, health + Math.ceil((maxHealth * rules.recoveryPercent) / 100))
      event('heroRecovered', { heroHealth: health })
    }
  }
  const master = {
    appeared: masterFights.length > 0,
    defeated: masterFights.some((entry) => entry.outcome === 'DEFEATED'),
    evaluations,
    encounters: masterFights,
  }
  const loot = bossDefeated
    ? (request.bossDrops ?? []).flatMap((drop) => {
        let quantity = 0
        for (let n = 0; n < drop.rolls; n += 1) {
          if (random.nextInt(8000) < Math.floor(drop.probability * 8000)) quantity += 1
        }
        return quantity === 0 ? [] : [{ label: drop.label, productId: drop.productId, quantity }]
      })
    : []
  event('simulationFinished', { combatOutcome: outcome, bossDefeated })
  return {
    simulationId: seed.simulationId,
    operationId: request.operationId,
    seedRef: seed.seedRef,
    combatOutcome: outcome,
    summary: {
      encountersCompleted: completed,
      encountersTotal: request.encounters.length,
      bossDefeated,
      minHealthPercent: Math.floor((minHealth * 100) / maxHealth),
      master,
      totalTurns,
      damageDealt,
      damageTaken,
      criticalEffects,
      skillsUsed: [...skillsUsed].map(([abilityId, count]) => ({ abilityId, count })),
      enemiesDefeated: [...defeated].map(([enemyRef, count]) => ({ enemyRef, count })),
      loot,
      simulatedDuration: isoDuration(elapsedSeconds),
    },
    combatLog: log,
  }
}

const durationSeconds = (text: string): number => {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/u.exec(text)
  return (Number(match?.[1] ?? 0) * 60 + Number(match?.[2] ?? 0)) * 60
}

const isoDuration = (seconds: number): string => {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return hours === 0
    ? `PT${String(remainder)}M`
    : `PT${String(hours)}H${remainder === 0 ? '' : `${String(remainder)}M`}`
}
