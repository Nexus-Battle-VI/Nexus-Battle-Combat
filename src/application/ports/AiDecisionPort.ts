import type { ActionIntent } from '../../domain/decision/ActionIntent'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'

/**
 * Interfaz asíncrona para permitir inferencia/búsqueda futura. Recibe únicamente
 * estado observable y candidatos legales: nunca infraestructura, servicios externos ni RNG.
 */
export interface AiDecisionPort {
  decide(state: BattleDecisionState, legalActions: readonly LegalAction[]): Promise<ActionIntent>
}
