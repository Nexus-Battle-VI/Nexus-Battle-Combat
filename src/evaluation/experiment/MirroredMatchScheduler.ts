import {
  matchupId,
  matchupIncludesMcts,
  type EvaluationConfig,
  type EvaluationMatchupTuple,
} from './EvaluationConfig'
import { generateSeedSequence, type EvaluationSide } from './EvaluationSeedSchedule'
import type { EvaluationPolicyId } from '../policies/EvaluationPolicyId'

export interface PlannedMatch {
  readonly scenarioId: string
  readonly matchup: EvaluationMatchupTuple
  readonly matchupIdValue: string
  readonly matchSeed: number
  readonly mirrorPairId: string
  readonly mirrorLeg: 'LEG_1' | 'LEG_2'
  readonly matchId: string
  readonly policyIdBySide: Readonly<Record<EvaluationSide, EvaluationPolicyId>>
}

/**
 * Genera el PLAN COMPLETO de partidas (EN-036.5, Management #569 §30-31,
 * §83): orden ESTABLE y explicito (escenario -> matchup -> seed -> leg,
 * nunca orden de `Map`/filesystem), espejado obligatorio (#569 §30) salvo
 * que se desactive explicitamente.
 *
 * Por cada `matchSeed`, LEG_1 asigna `matchup[0]` al lado A y
 * `matchup[1]` al lado B; LEG_2 INTERCAMBIA que politica juega cada
 * lado, pero el escenario (y por tanto el loadout de CADA lado) se
 * mantiene igual: asi ambas politicas juegan ambos lados Y ambos
 * loadouts con la MISMA raiz de semilla (#569 §30-31).
 *
 * MCTS usa su propia muestra (`mctsSeedCount`, #569 §72, §124-125): nunca
 * comparte `seedCount` con Random/RuleBased/Neural, que son mucho mas
 * baratos.
 */
export const scheduleMirroredMatches = (config: EvaluationConfig): readonly PlannedMatch[] => {
  const plans: PlannedMatch[] = []

  for (const scenarioId of config.scenarioIds) {
    for (const matchup of config.matchups) {
      const includesMcts = matchupIncludesMcts(matchup)

      if (includesMcts && config.skipExpensiveMcts) {
        continue
      }

      const seeds = generateSeedSequence(
        config.seedStart,
        includesMcts ? config.mctsSeedCount : config.seedCount,
      )
      const matchupIdValue = matchupId(matchup)

      for (const matchSeed of seeds) {
        const mirrorPairId = `${scenarioId}:${matchupIdValue}:seed-${String(matchSeed)}`

        plans.push({
          scenarioId,
          matchup,
          matchupIdValue,
          matchSeed,
          mirrorPairId,
          mirrorLeg: 'LEG_1',
          matchId: `${mirrorPairId}:leg-1`,
          policyIdBySide: { A: matchup[0], B: matchup[1] },
        })

        if (config.mirrorEnabled) {
          plans.push({
            scenarioId,
            matchup,
            matchupIdValue,
            matchSeed,
            mirrorPairId,
            mirrorLeg: 'LEG_2',
            matchId: `${mirrorPairId}:leg-2`,
            policyIdBySide: { A: matchup[1], B: matchup[0] },
          })
        }
      }
    }
  }

  return plans
}
