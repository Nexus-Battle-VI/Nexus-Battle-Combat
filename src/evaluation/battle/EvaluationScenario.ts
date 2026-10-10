import type { CombatProfile } from '../../domain/entities/CombatProfile'

export const EVALUATION_SCENARIOS_VERSION = 'evaluation-scenarios-v1'

/**
 * Escenario de evaluacion versionado (EN-036.5, Management #569 §38-39):
 * fixture de evaluacion CONTROLADO, nunca datos de jugadores reales. 1v1
 * (decision tecnica v1, no exigida por el issue): cada lado tiene UN
 * combatiente, lo que simplifica la atribucion de metricas (Poder/daño por
 * LADO sin agregar sobre varios combatientes) y coincide con la forma en
 * que los fixtures reales de este repo (`battleWithCombat`/
 * `battleWithSkills`/`battleWithEpic`) ya construyen sus salas de prueba.
 */
export interface EvaluationScenario {
  readonly scenarioId: string
  readonly scenarioVersion: typeof EVALUATION_SCENARIOS_VERSION
  readonly description: string
  readonly teamAProfile: CombatProfile
  readonly teamBProfile: CombatProfile
}
