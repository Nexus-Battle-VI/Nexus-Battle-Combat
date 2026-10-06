import type { CombatDecisionOrigin } from './CombatDecisionEvent'
import type { BattleMode } from '../value-objects/BattleMode'
import { legalActionIdentity } from './ActionIdentity'
import type { LegalAction } from './LegalAction'
import type { MctsTeacherResult } from './MctsTeacherResult'

export const MCTS_TEACHER_LABEL_SCHEMA_VERSION = 1 as const

/**
 * Contrato OFICIAL del teacher label en vivo (EN-036.1 #565 + EN-036.2 #566,
 * correccion de alcance sobre PR#81): liga un `MctsTeacherResult` (busqueda
 * ya ejecutada sobre el `BattleRoom` PRE-ACCION) a la decision real que lo
 * origino, por `eventId` -- la MISMA identidad que ya usa `CombatDecisionEvent`
 * (`onlineDecisionEventId`/`missionDecisionEventId`). Append-only: nunca se
 * actualiza ni se borra.
 *
 * `battleId`/`decisionSequence` viajan REDUNDANTES con `eventId` a proposito
 * (igual que en `CombatDecisionEvent`): permiten validar la relacion sin
 * tener que decodificar el `eventId` opaco, y sirven de respaldo para
 * detectar un join inconsistente (`eventId` coincide pero `battleId`/
 * `decisionSequence` no) en vez de aceptarlo a ciegas.
 */
export interface MctsTeacherLabel {
  readonly schemaVersion: typeof MCTS_TEACHER_LABEL_SCHEMA_VERSION
  readonly eventId: string
  readonly battleId: string
  readonly decisionSequence: number
  readonly origin: CombatDecisionOrigin
  readonly mode: BattleMode
  /** Resultado producido por `MctsTeacher.teach(...)` sobre el estado PRE-ACCION. */
  readonly result: MctsTeacherResult
  readonly generatedAt: Date
}

/**
 * `result.candidates` SIEMPRE es subconjunto de `legalActions` (§5, correccion
 * de alcance sobre PR#81): `filterStrategicCandidates`/la interseccion con
 * rotacion de Mision pueden descartar opciones legales, nunca inventar una.
 * NO exige igualdad -- exigirla romperia cualquier busqueda que haya
 * filtrado una curacion desperdiciada o restringido por rotacion.
 */
export const teacherCandidatesAreSubsetOfLegalActions = (
  label: Pick<MctsTeacherLabel, 'result'>,
  legalActions: readonly LegalAction[],
): boolean => {
  const legalIdentities = new Set(legalActions.map((action) => legalActionIdentity(action)))

  return label.result.candidates.every((candidate) =>
    legalIdentities.has(legalActionIdentity(candidate.action)),
  )
}
