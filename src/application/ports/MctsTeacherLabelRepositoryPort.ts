import type { MctsTeacherLabel } from '../../domain/decision/MctsTeacherLabel'

/**
 * Puerto append-only para `MctsTeacherLabel` (EN-036.2 #566, correccion de
 * alcance sobre PR#81). Mismo criterio que
 * `CombatDecisionTelemetryRepositoryPort`: sin `update`/`delete`/`replace`.
 * `_id = eventId` en la implementacion real, para que repetir el mismo
 * `eventId` con el MISMO contenido sea idempotente (ok) y con contenido
 * DISTINTO falle (`MctsTeacherLabelConflictError`), nunca sobrescriba.
 */
export interface MctsTeacherLabelRepositoryPort {
  append(label: MctsTeacherLabel): Promise<void>
  findByEventId(eventId: string): Promise<MctsTeacherLabel | null>
}

export const MCTS_TEACHER_LABEL_REPOSITORY = Symbol('MctsTeacherLabelRepositoryPort')
