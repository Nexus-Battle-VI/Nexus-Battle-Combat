import { resolveLegalAction } from '../../domain/decision/ActionIdentity'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { MctsTeacher } from '../../application/services/MctsTeacher'
import { deriveMctsSeed } from '../experiment/EvaluationSeedSchedule'
import type { EvaluationDecisionContext, EvaluationPolicy } from './EvaluationPolicy'

/**
 * Adaptador EXCLUSIVO del harness (EN-036.5, Management #569 §19-21): MCTS
 * no implementa `AiDecisionPort` (necesita el `BattleRoom` completo, no
 * solo `BattleDecisionState`), asi que esta clase llama directamente a
 * `MctsTeacher.teach(room, simulationSeed)` -- nunca modifica
 * `MctsTeacher`/`MctsSearch` en si.
 *
 * Semilla NUEVA por decision (#569 §28, vease `deriveMctsSeed`): nunca la
 * misma `simulationSeed` en dos turnos de la misma partida.
 *
 * `teacherResult.candidates` puede ser un SUBCONJUNTO legitimo de
 * `legalActions` (filtro de curaciones no estrategicas, #569 §110): esta
 * clase NUNCA compara ambos conjuntos, solo valida que `selectedAction`
 * resuelva contra las `legalActions` ACTUALES.
 *
 * `NoStrategicMctsCandidatesError` (y cualquier otro error de
 * `MctsTeacher`) se propaga tal cual -- NUNCA cae en silencio a
 * `RuleBasedPolicy` y sigue llamandose "MCTS" (#569 §21): el runner del
 * harness es quien decide como registrar ese fallo
 * (`MCTS_NO_STRATEGIC_CANDIDATES`), nunca esta clase.
 */
export class MctsEvaluationPolicy implements EvaluationPolicy {
  readonly id = 'MCTS' as const

  constructor(private readonly teacher: MctsTeacher) {}

  async decide(context: EvaluationDecisionContext): Promise<LegalAction> {
    const simulationSeed = deriveMctsSeed(context.matchSeed, context.side, context.decisionIndex)
    const result = await this.teacher.teach(context.room, simulationSeed)

    // `LegalAction` y `ActionIntent` son uniones estructuralmente
    // identicas (#569 §111): `resolveLegalAction` acepta `selectedAction`
    // directamente, sin cast, porque TypeScript ya las ve compatibles.
    return resolveLegalAction(result.selectedAction, context.legalActions)
  }
}
