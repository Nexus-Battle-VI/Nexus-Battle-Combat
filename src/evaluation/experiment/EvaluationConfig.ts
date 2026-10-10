import type { MctsTeacherConfig } from '../../domain/decision/MctsTeacherResult'
import type { EvaluationPolicyId } from '../policies/EvaluationPolicyId'

export const EVALUATION_CONFIG_VERSION = 'evaluation-config-v1'

/** Los 6 matchups exigidos por #569 §33, §171, en orden canonico. */
export type EvaluationMatchupTuple = readonly [EvaluationPolicyId, EvaluationPolicyId]

export const REQUIRED_EVALUATION_MATCHUPS: readonly EvaluationMatchupTuple[] = [
  ['RANDOM', 'RULE_BASED'],
  ['MCTS', 'RANDOM'],
  ['MCTS', 'RULE_BASED'],
  ['NEURAL', 'RANDOM'],
  ['NEURAL', 'RULE_BASED'],
  ['NEURAL', 'MCTS'],
]

export const matchupId = (matchup: EvaluationMatchupTuple): string =>
  `${matchup[0]}_vs_${matchup[1]}`

/** Si el purpose del modelo cargado es SMOKE_TEST, el config correspondiente TAMBIEN lo es (#569 §119, §141). */
export type EvaluationPurpose = 'SMOKE_TEST' | 'FULL_EVALUATION'

export interface NeuralArtifactConfig {
  readonly onnxPath: string
  readonly manifestPath: string
  readonly allowSmokeModel: boolean
  readonly inferenceTimeoutMs: number
}

export interface EvaluationConfig {
  readonly configVersion: typeof EVALUATION_CONFIG_VERSION
  readonly purpose: EvaluationPurpose
  readonly scenarioIds: readonly string[]
  readonly matchups: readonly EvaluationMatchupTuple[]
  readonly seedStart: number
  readonly seedCount: number
  /** Muestra PROPIA para matchups que incluyen MCTS (#569 §72, §124-125): nunca comparte `seedCount`. */
  readonly mctsSeedCount: number
  readonly mctsConfig: MctsTeacherConfig
  readonly maxPlies: number
  readonly mirrorEnabled: boolean
  readonly neuralArtifact: NeuralArtifactConfig | null
  readonly skipExpensiveMcts: boolean
  readonly sourceCommit: string
}

/** Un matchup incluye MCTS como alguno de sus dos lados. */
export const matchupIncludesMcts = (matchup: EvaluationMatchupTuple): boolean =>
  matchup[0] === 'MCTS' || matchup[1] === 'MCTS'

/** Un matchup incluye Neural como alguno de sus dos lados. */
export const matchupIncludesNeural = (matchup: EvaluationMatchupTuple): boolean =>
  matchup[0] === 'NEURAL' || matchup[1] === 'NEURAL'
