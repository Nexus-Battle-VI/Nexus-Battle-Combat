import type { RandomSequenceFactoryPort } from '../ports/RandomSequencePort'
import type { MissionSeed } from '../ports/MissionSeedPort'
import type { AiDecisionPort } from '../ports/AiDecisionPort'
import { createBoundedRandom } from './BoundedRandom'
import {
  MissionRotationConstraint,
  type MissionRotation,
  type MissionRotationStrategyTrace,
} from './MissionRotationConstraint'
import {
  applyLevelToMagnitudeResult,
  calculateDamage,
} from '../../domain/policies/BasicAttackDamagePolicy'
import { dieFaceFromIndex } from '../../domain/policies/AttackProfile'
import {
  evaluateMissionAbility,
  type MissionEffect,
  type MissionStatistic,
} from '../../domain/policies/MissionAbilityPolicy'
import type { SkillBonus } from '../../domain/policies/SkillEffectPolicy'
import type { CombatAbility, CombatMagnitude } from '../../domain/entities/CombatProfile'
import { RandomSeed } from '../../domain/value-objects/RandomSeed'
import { ParticipantKind } from '../../domain/entities/Participant'
import { BattleMode } from '../../domain/value-objects/BattleMode'
import { resolveLegalAction } from '../../domain/decision/ActionIdentity'
import { NoLegalDecisionActionsError } from '../../domain/errors/DecisionContractErrors'
import type {
  BattleDecisionState,
  DecisionCombatant,
} from '../../domain/decision/BattleDecisionState'

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
      /** HU-08 (CA-06): nivel del heroe; multiplica el resultado final de su Dano. Ausente = 1. */
      readonly level?: number
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

interface ChosenAction {
  readonly kind: 'BASIC_ATTACK' | 'ABILITY'
  readonly ability?: CombatAbility
  readonly strategy: MissionRotationStrategyTrace
}

/** Un modificador de estadística con duración (mejora del héroe o penalización del enemigo). */
interface TimedModifier {
  /** Habilidad que lo originó (revisión de PR #71): permite representar `activeEffects` con honestidad. */
  readonly sourceAbilityId: string
  readonly statistic: MissionStatistic
  readonly amount: number
  /** Rondas que le quedan, contando la actual. */
  remaining: number
}

/** Quita las entradas que ya gastaron sus rondas, sin cambiar la referencia de la lista. */
const dropSpent = (list: { remaining: number }[]): void => {
  const alive = list.filter((entry) => entry.remaining > 0)
  list.splice(0, list.length, ...alive)
}

const DEFAULT_RULES = {
  turnDurationSeconds: 60,
  maxTurnsPerEncounter: 30,
  recoveryPercent: 35,
  criticalChance: 0.1,
  criticalMultiplier: 1.5,
} as const

/**
 * Convencion honesta de Mision (EN-035.3, ADR-023): es un duelo 1v1, sin
 * equipos ni asientos reales, asi que `CombatantKey` no existe de forma
 * natural. `teamLabel` es un string generico (`Combatant.ts`); se usan estas
 * dos etiquetas fijas solo para poder construir `BattleDecisionState`/
 * `LegalAction` sin inventar datos que no existen.
 */
const MISSION_HERO_KEY = Object.freeze({ teamLabel: 'HERO', seat: 0 })
const MISSION_ENEMY_KEY = Object.freeze({ teamLabel: 'ENEMY', seat: 0 })
const MISSION_ENEMY_TARGET = Object.freeze({
  scope: 'COMBATANT' as const,
  combatant: MISSION_ENEMY_KEY,
})

/** A fixed request and operation produce the same private sequence on every replica. */
export const simulateMission = async (
  request: MissionSimulationRequest,
  seed: MissionSeed,
  sequences: RandomSequenceFactoryPort,
  decisionPolicy: AiDecisionPort,
): Promise<MissionSimulationResult> => {
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
  /** Mejoras propias con duración: siguen activas entre peleas hasta gastar sus rondas. */
  const heroModifiers: TimedModifier[] = []
  /** Curaciones de las rondas siguientes (curación en el tiempo). */
  const pendingHeals: { readonly amount: SkillBonus; remaining: number }[] = []
  let immunityRounds = 0
  let reflect: { readonly basisPoints: number; remaining: number } | null = null
  let healingDone = 0
  let abilityDamage = 0

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
  const modifierOf = (list: readonly TimedModifier[], statistic: MissionStatistic): number =>
    list.reduce((sum, entry) => (entry.statistic === statistic ? sum + entry.amount : sum), 0)
  /** Cura sin pasar de la vida máxima y devuelve cuánto curó de verdad. */
  const heal = (amount: number): number => {
    const before = health
    health = Math.min(maxHealth, health + amount)
    healingDone += health - before
    return health - before
  }
  const rotationConstraint = new MissionRotationConstraint()
  const missionRotations: readonly MissionRotation[] = request.strategy.rotations
  /**
   * Traduce `heroModifiers`/`enemyModifiers` (buffs/debuffs con duración ya
   * existentes) a `DecisionActiveEffect` con honestidad (revisión de PR #71):
   * `sourceAbilityId` ahora sí se registra en `TimedModifier`, así que no
   * hace falta inventarlo. `heroModifiers` siempre sube una estadística
   * propia (INCREASE); `enemyModifiers` siempre baja una del enemigo
   * (DECREASE) -- implícito por la lista en la que `applyEffect` los empuja
   * (`MissionAbilityPolicy.effectOf`), nunca un dato fabricado aquí.
   *
   * Pendiente real, declarado y no resuelto en esta Task: `IMMUNITY`
   * (`immunityRounds`) y el reflejo de daño no se representan -- Misiones
   * los trackea como contadores sueltos sin `sourceAbilityId` ni
   * `sourceCombatant`, y `REFLECT` ni siquiera es una variante de
   * `DecisionActiveEffect` en el contrato de #562. Ampliarlos queda para
   * cuando una política lo necesite.
   */
  const activeEffectsOf = (
    modifiers: readonly TimedModifier[],
    sourceCombatant: typeof MISSION_HERO_KEY | typeof MISSION_ENEMY_KEY,
    operation: 'INCREASE' | 'DECREASE',
  ): readonly DecisionCombatant['activeEffects'][number][] =>
    modifiers.map((modifier) => ({
      kind: 'STAT' as const,
      sourceAbilityId: modifier.sourceAbilityId,
      sourceCombatant,
      statistic: modifier.statistic,
      operation,
      amount: modifier.amount,
      remainingOwnTurns: modifier.remaining,
    }))
  /**
   * Vista honesta del heroe/enemigo para `AiDecisionPort` (EN-035.3, ADR-023,
   * revisión de PR #71): el enemigo ya trae sus stats reales de combate
   * (`attack`/`defense`/`damage`), tomadas del mismo objeto `enemy` que usa
   * `fight()` para resolver la pelea -- nunca `null` por pereza. `power`
   * sigue `null` porque los enemigos de Misión genuinamente no usan Poder
   * (EN-036 #555).
   */
  const buildDecisionState = (
    enemy: {
      readonly maxHealth: number
      readonly attack: number
      readonly defense: number
      readonly damage: CombatMagnitude
    },
    enemyHealth: number,
    enemyModifiers: readonly TimedModifier[],
    roundTurns: number,
  ): BattleDecisionState => {
    const actor: DecisionCombatant = {
      identity: MISSION_HERO_KEY,
      kind: ParticipantKind.Ai,
      heroSubtype: request.hero.profile.subtype,
      health: { current: health, max: maxHealth },
      power: { current: power, max: heroStats.power },
      attack: heroStats.attack,
      defense: heroStats.defense,
      damage: heroStats.damage,
      level: request.hero.profile.level ?? null,
      cooldowns: [...cooldowns].map(([abilityId, remainingOwnTurns]) => ({
        abilityId,
        remainingOwnTurns,
      })),
      abilities: request.hero.profile.abilities.map((ability) => ({
        abilityId: ability.abilityId,
        powerCost: ability.powerCost,
        chargeTurns: ability.chargeTurns,
        effects: ability.effects.map((effect) => ({
          kind: effect.kind,
          target: effect.target,
          ...(effect.statistic === undefined ? {} : { statistic: effect.statistic }),
          ...(effect.operation === undefined ? {} : { operation: effect.operation }),
          ...(effect.magnitude === undefined ? {} : { magnitude: effect.magnitude }),
          ...(effect.durationTurns === undefined ? {} : { durationTurns: effect.durationTurns }),
          hasActivationCondition: effect.hasActivationCondition,
          ...(effect.immunityCode === undefined ? {} : { immunityCode: effect.immunityCode }),
        })),
      })),
      epic: null,
      activeEffects: activeEffectsOf(heroModifiers, MISSION_HERO_KEY, 'INCREASE'),
      damageMemory: null,
    }
    const enemyCombatant: DecisionCombatant = {
      identity: MISSION_ENEMY_KEY,
      kind: ParticipantKind.Ai,
      heroSubtype: null,
      health: { current: enemyHealth, max: enemy.maxHealth },
      power: null,
      attack: enemy.attack,
      defense: enemy.defense,
      damage: enemy.damage,
      level: null,
      cooldowns: [],
      abilities: [],
      epic: null,
      activeEffects: activeEffectsOf(enemyModifiers, MISSION_ENEMY_KEY, 'DECREASE'),
      damageMemory: null,
    }

    return {
      schemaVersion: 1,
      context: {
        battleId: request.operationId,
        mode: BattleMode.Pve,
        round: roundTurns,
        turnsCompleted: Math.max(0, roundTurns - 1),
      },
      actor,
      allies: [],
      enemies: [enemyCombatant],
    }
  }
  /**
   * Decisión por turno de HU-71 (diseño `hu-71-rotaciones-habilidades`, P-R5 a P-R7
   * y tabla D-1 a D-6), delegada en `MissionRotationConstraint` + `AiDecisionPort`
   * desde EN-035.3: la restricción filtra qué puede ofrecerse, la política decide
   * entre lo ofrecido, Combat (aquí, `MissionSimulation`) ejecuta.
   */
  const chooseAction = async (
    enemy: {
      readonly maxHealth: number
      readonly attack: number
      readonly defense: number
      readonly damage: CombatMagnitude
    },
    enemyHealth: number,
    enemyModifiers: readonly TimedModifier[],
    roundTurns: number,
  ): Promise<ChosenAction> => {
    const evaluation = rotationConstraint.evaluate({
      rotations: missionRotations,
      cursors,
      abilities,
      cooldowns,
      power,
      health,
      maxHealth,
      enemyTarget: MISSION_ENEMY_TARGET,
    })
    const state = buildDecisionState(enemy, enemyHealth, enemyModifiers, roundTurns)
    const intent = await decisionPolicy.decide(state, evaluation.legalActions)
    const resolved = resolveLegalAction(intent, evaluation.legalActions)
    const strategy = evaluation.resolve(resolved)

    if (resolved.kind === 'EPIC') {
      // Misiones nunca ofrece candidatas EPIC (no hay épica en este modo);
      // llegar aquí sería una política fabricando una acción inexistente.
      throw new NoLegalDecisionActionsError()
    }
    if (resolved.kind === 'BASIC_ATTACK') {
      return { kind: 'BASIC_ATTACK', strategy }
    }

    const ability = abilities.get(resolved.abilityId)

    if (ability === undefined) {
      throw new NoLegalDecisionActionsError()
    }

    return { kind: 'ABILITY', ability, strategy }
  }
  const fight = async (
    enemyRef: string,
    base: MissionFighter,
    multiplier: number,
    maxTurns: number,
    encounter: number,
    instance: number,
  ): Promise<{
    readonly status: 'DEFEATED' | 'HERO_DEFEATED' | 'ESCAPED'
    readonly turns: number
  }> => {
    const enemy = {
      maxHealth: Math.max(1, Math.ceil(base.maxHealth * multiplier)),
      attack: Math.ceil(base.attack * multiplier),
      defense: Math.ceil(base.defense * multiplier),
      damage: base.damage,
    }
    let enemyHealth = enemy.maxHealth
    let guard = 0
    let turns = 0
    /** Penalizaciones al enemigo de esta pelea; terminan con él. */
    const enemyModifiers: TimedModifier[] = []
    /** Fin de ronda: cada efecto con duración gasta una. */
    const endRound = (): void => {
      for (const entry of heroModifiers) entry.remaining -= 1
      for (const entry of enemyModifiers) entry.remaining -= 1
      dropSpent(heroModifiers)
      dropSpent(enemyModifiers)
      if (immunityRounds > 0) immunityRounds -= 1
      if (reflect !== null)
        reflect = reflect.remaining > 1 ? { ...reflect, remaining: reflect.remaining - 1 } : null
    }
    /** Aplica un efecto de habilidad (P-J4) y devuelve lo que queda en la bitácora. */
    const applyEffect = (
      effect: MissionEffect,
      sourceAbilityId: string,
    ): Readonly<Record<string, unknown>> => {
      switch (effect.kind) {
        case 'MODIFIER': {
          const amount = bonus(effect.amount)
          const list = effect.target === 'SELF' ? heroModifiers : enemyModifiers
          list.push({
            sourceAbilityId,
            statistic: effect.statistic,
            amount,
            remaining: effect.turns,
          })
          return {
            kind: effect.target === 'SELF' ? 'BUFF' : 'DEBUFF',
            statistic: effect.statistic,
            amount,
            turns: effect.turns,
          }
        }
        case 'DIRECT_DAMAGE': {
          const amount = Math.min(enemyHealth, Math.max(1, bonus(effect.amount)))
          enemyHealth -= amount
          damageDealt += amount
          abilityDamage += amount
          return { kind: 'DIRECT_DAMAGE', amount }
        }
        case 'HEAL': {
          const amount = heal(bonus(effect.amount))
          if (effect.turns > 1) {
            pendingHeals.push({ amount: effect.amount, remaining: effect.turns - 1 })
          }
          return { kind: 'HEAL', amount, turns: effect.turns, heroHealth: health }
        }
        case 'HEAL_PERCENT': {
          const amount = heal(Math.floor((maxHealth * effect.basisPoints) / 10_000))
          return { kind: 'HEAL', amount, turns: 1, heroHealth: health }
        }
        case 'IMMUNITY':
          immunityRounds = Math.max(immunityRounds, effect.turns)
          return { kind: 'IMMUNITY', turns: effect.turns }
        case 'REFLECT':
          reflect = { basisPoints: effect.basisPoints, remaining: effect.turns }
          return { kind: 'REFLECT', basisPoints: effect.basisPoints, turns: effect.turns }
      }
    }
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
      for (const pending of pendingHeals) {
        const amount = heal(bonus(pending.amount))
        pending.remaining -= 1
        event('heroHealed', { amount, heroHealth: health })
      }
      dropSpent(pendingHeals)
      const action = await chooseAction(enemy, enemyHealth, enemyModifiers, turns)
      let attackBonus = 0
      let damageBonus = 0
      let attacks = true
      let powerSpent = 0
      const effects: Readonly<Record<string, unknown>>[] = []
      if (action.kind === 'ABILITY' && action.ability !== undefined) {
        const support = evaluateMissionAbility(action.ability)
        if (support.supported) {
          // Mismo orden de dados que antes: primero las bonificaciones del turno.
          attackBonus = bonus(support.attackBonus)
          damageBonus = bonus(support.damageBonus)
          powerSpent =
            action.ability.powerCost.mode === 'ALL_AVAILABLE'
              ? power
              : action.ability.powerCost.amount
          power -= powerSpent
          cooldowns.set(action.ability.abilityId, action.ability.chargeTurns + 1)
          skillsUsed.set(
            action.ability.abilityId,
            (skillsUsed.get(action.ability.abilityId) ?? 0) + 1,
          )
          attacks = support.attacks
          for (const effect of support.effects) {
            effects.push(applyEffect(effect, action.ability.abilityId))
          }
        }
      }
      let hit = false
      let dealt = 0
      let critical = false
      if (attacks && enemyHealth > 0) {
        hit =
          heroAttack + attackBonus + modifierOf(heroModifiers, 'ATTACK') + roll(20) >=
          enemy.defense + guard - modifierOf(enemyModifiers, 'DEFENSE') + 10
        if (hit) {
          critical = random.nextInt(8000) < Math.floor(rules.criticalChance * 8000)
          // CA-06 (opcion A): nivel x resultado de la magnitud; los bonos se suman despues.
          const baseDamage =
            applyLevelToMagnitudeResult(magnitude(heroDamage), request.hero.profile.level) +
            damageBonus +
            modifierOf(heroModifiers, 'DAMAGE')
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
      }
      guard = 0
      event('heroAction', {
        enemyRef,
        action: action.kind,
        abilityId: action.ability?.abilityId ?? null,
        strategy: action.strategy,
        hit,
        damage: dealt,
        critical,
        enemyHealth,
        ...(action.kind === 'ABILITY' ? { powerSpent } : {}),
        ...(attacks ? {} : { attacked: false }),
        ...(effects.length === 0 ? {} : { effects }),
      })
      if (enemyHealth === 0) {
        endRound()
        break
      }
      if (base.ai === 'GUARDED' && turns % 3 === 0) {
        guard = 4
        event('enemyGuarded', { enemyRef, defenseBonus: guard })
        endRound()
        continue
      }
      const enraged =
        base.ai === 'BOSS' && enemyHealth * 100 <= enemy.maxHealth * (base.enrageBelowPercent ?? 50)
      const enemyAttack =
        enemy.attack +
        (enraged ? (base.enrageAttackBonus ?? 0) : 0) -
        modifierOf(enemyModifiers, 'ATTACK')
      const enemyHit =
        enemyAttack + roll(20) >= heroStats.defense + modifierOf(heroModifiers, 'DEFENSE') + 10
      const softened = modifierOf(enemyModifiers, 'DAMAGE')
      let taken = 0
      if (enemyHit) {
        const raw = magnitude(enemy.damage)
        taken = Math.min(health, softened > 0 ? Math.max(0, raw - softened) : Math.max(1, raw))
      }
      const prevented = immunityRounds > 0 ? taken : 0
      taken -= prevented
      const returned = reflect !== null ? Math.floor((taken * reflect.basisPoints) / 10_000) : 0
      taken -= returned
      const reflected = Math.min(enemyHealth, returned)
      enemyHealth -= reflected
      damageDealt += reflected
      abilityDamage += reflected
      health -= taken
      damageTaken += taken
      minHealth = Math.min(minHealth, health)
      event('enemyAction', {
        enemyRef,
        hit: enemyHit,
        damage: taken,
        heroHealth: health,
        enraged,
        ...(prevented > 0 ? { prevented } : {}),
        ...(reflected > 0 ? { reflected } : {}),
      })
      endRound()
    }
    if (health === 0) return { status: 'HERO_DEFEATED', turns }
    defeated.set(enemyRef, (defeated.get(enemyRef) ?? 0) + 1)
    // Forma de los contratos de HU-72 y HU-09: la INSTANCIA derrotada con su encuentro.
    // Missions crea con ella una recompensa de experiencia por cada baja.
    event('combatantDefeated', {
      encounter,
      turn: totalTurns,
      combatant: `${enemyRef}#${String(instance)}`,
    })
    return { status: 'DEFEATED', turns }
  }

  const masterInstances = new Map<string, number>()
  for (const encounter of request.encounters) {
    event('encounterStarted', { encounter: encounter.index, kind: encounter.kind })
    let encounterTurns = 0
    const instances = new Map<string, number>()
    for (const enemy of encounter.enemies) {
      for (let n = 0; n < enemy.count; n += 1) {
        const instance = (instances.get(enemy.enemyRef) ?? 0) + 1
        instances.set(enemy.enemyRef, instance)
        const result = await fight(
          enemy.enemyRef,
          enemy.profile,
          request.enemyStatMultiplier * (1 + (encounter.powerStep ?? 0)),
          rules.maxTurnsPerEncounter - encounterTurns,
          encounter.index,
          instance,
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
          const instance = (masterInstances.get(candidate.masterRef) ?? 0) + 1
          masterInstances.set(candidate.masterRef, instance)
          const result = await fight(
            candidate.masterRef,
            candidate.profile,
            1,
            rules.maxTurnsPerEncounter,
            point.afterEncounter,
            instance,
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
      healingDone,
      abilityDamage,
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
