import type { ClockPort } from '../../application/ports/ClockPort'
import type { RandomSequenceFactoryPort } from '../../application/ports/RandomSequencePort'
import { RandomSeed } from '../../domain/value-objects/RandomSeed'
import { buildEvaluationBattleRoom } from '../battle/EvaluationBattleFactory'
import { runAcceleratedBattle } from '../battle/AcceleratedBattleRunner'
import type { EvaluationMatchResultV1 } from '../battle/EvaluationMatchResult'
import { EVALUATION_SCENARIOS } from '../battle/EvaluationScenarioCatalog'
import type { EvaluationPolicy } from '../policies/EvaluationPolicy'
import type { EvaluationPolicyId } from '../policies/EvaluationPolicyId'
import type { EvaluationConfig } from './EvaluationConfig'
import {
  deriveCombatSeed,
  deriveRandomPolicySeed,
  deriveTurnOrderSeed,
  type EvaluationSide,
} from './EvaluationSeedSchedule'
import { scheduleMirroredMatches } from './MirroredMatchScheduler'
import { RandomEvaluationPolicy } from '../policies/RandomEvaluationPolicy'

export interface PolicyComparisonHarnessDeps {
  readonly randomSequenceFactory: RandomSequenceFactoryPort
  readonly ruleBasedPolicy: EvaluationPolicy
  /** `null` si ningun matchup configurado requiere MCTS. */
  readonly mctsPolicy: EvaluationPolicy | null
  /** `null` si ningun matchup configurado requiere Neural. */
  readonly neuralPolicy: EvaluationPolicy | null
  readonly clock: ClockPort
}

export type MatchProgressCallback = (
  result: EvaluationMatchResultV1,
  completed: number,
  total: number,
) => void

const resolvePolicy = (
  policyId: EvaluationPolicyId,
  matchSeed: number,
  side: EvaluationSide,
  deps: PolicyComparisonHarnessDeps,
): EvaluationPolicy => {
  switch (policyId) {
    case 'RANDOM': {
      const seed = deriveRandomPolicySeed(matchSeed, side)
      return new RandomEvaluationPolicy(deps.randomSequenceFactory.create(RandomSeed.create(seed)))
    }
    case 'RULE_BASED':
      return deps.ruleBasedPolicy
    case 'MCTS':
      if (deps.mctsPolicy === null) {
        throw new Error(
          'El matchup requiere MCTS, pero no se configuro una MctsTeacher (#569 §169).',
        )
      }
      return deps.mctsPolicy
    case 'NEURAL':
      if (deps.neuralPolicy === null) {
        throw new Error(
          'El matchup requiere Neural, pero el artefacto no cargo (#569 §169: debe fallar antes ' +
            'de arrancar combates, nunca saltarse en silencio).',
        )
      }
      return deps.neuralPolicy
  }
}

/**
 * Ejecuta el PLAN COMPLETO de partidas espejadas (EN-036.5, Management
 * #569 §84: secuencial, `concurrency = 1`, por reproducibilidad y porque
 * MCTS/ONNX son CPU-intensivos y comparten estado stateless reutilizable
 * -- nunca paralelo en v1).
 */
export const runPolicyComparisonHarness = async (
  config: EvaluationConfig,
  deps: PolicyComparisonHarnessDeps,
  evaluationId: string,
  onMatchCompleted?: MatchProgressCallback,
): Promise<readonly EvaluationMatchResultV1[]> => {
  const plans = scheduleMirroredMatches(config)
  const results: EvaluationMatchResultV1[] = []

  for (const plan of plans) {
    const scenario = EVALUATION_SCENARIOS.find(
      (candidate) => candidate.scenarioId === plan.scenarioId,
    )
    if (scenario === undefined) {
      throw new Error(`Escenario desconocido en el plan: "${plan.scenarioId}".`)
    }

    const combatSeed = deriveCombatSeed(plan.matchSeed)
    const turnOrderSeed = deriveTurnOrderSeed(plan.matchSeed)
    const combatSequence = deps.randomSequenceFactory.create(RandomSeed.create(combatSeed))
    const turnOrderSequence = deps.randomSequenceFactory.create(RandomSeed.create(turnOrderSeed))
    const at = deps.clock.now()

    const room = buildEvaluationBattleRoom({
      roomIdSeed: `eval-room:${plan.matchId}`,
      teamAProfile: scenario.teamAProfile,
      teamBProfile: scenario.teamBProfile,
      turnOrderSequence,
      at,
    })

    const policyA = resolvePolicy(plan.policyIdBySide.A, plan.matchSeed, 'A', deps)
    const policyB = resolvePolicy(plan.policyIdBySide.B, plan.matchSeed, 'B', deps)

    const result = await runAcceleratedBattle({
      evaluationId,
      matchId: plan.matchId,
      mirrorPairId: plan.mirrorPairId,
      mirrorLeg: plan.mirrorLeg,
      matchupId: plan.matchupIdValue,
      scenarioId: plan.scenarioId,
      matchSeed: plan.matchSeed,
      combatSeed,
      room,
      policyA,
      policyB,
      combatSequence,
      clock: deps.clock,
      maxPlies: config.maxPlies,
    })

    results.push(result)
    onMatchCompleted?.(result, results.length, plans.length)
  }

  return results
}
