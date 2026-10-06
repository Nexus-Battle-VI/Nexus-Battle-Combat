import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { CombatDecisionEvent } from '../../domain/decision/CombatDecisionEvent'
import {
  MCTS_TEACHER_LABEL_SCHEMA_VERSION,
  teacherCandidatesAreSubsetOfLegalActions,
  type MctsTeacherLabel,
} from '../../domain/decision/MctsTeacherLabel'
import type { MctsTeacherResult } from '../../domain/decision/MctsTeacherResult'
import { deriveLiveTeacherSeed } from '../../domain/policies/MctsSeedDerivation'
import { MctsTeacherLabelValidationError } from '../../domain/errors/MctsErrors'
import type { ClockPort } from '../ports/ClockPort'
import type { MctsTeacherLabelRepositoryPort } from '../ports/MctsTeacherLabelRepositoryPort'
import type { MctsTeacher } from './MctsTeacher'

export interface LiveMctsTeacherLabelerLogger {
  error(message: string, context?: Readonly<Record<string, string | number>>): void
}

/**
 * `teach()` ya fue lanzado (con `.catch()` adjunto) sobre la sala PRE-ACCION;
 * `decision` es el `CombatDecisionEvent` YA PREPARADO (todavia no persistido)
 * que lo origino. `result === null` significa que `teach()` fallo y el
 * motivo ya quedo logueado -- `persist()` no debe volver a loguearlo.
 */
export interface PendingMctsTeacherLabel {
  readonly decision: CombatDecisionEvent
  readonly result: Promise<MctsTeacherResult | null>
}

/**
 * Orquesta la generacion EN VIVO del teacher label MCTS (EN-036.1 #565 +
 * EN-036.2 #566, correccion de alcance sobre PR#81).
 *
 * Dos invariantes NO negociables:
 *
 *  1. **Fail-open para gameplay** (§15): un fallo de MCTS o de persistencia
 *     del label NUNCA rechaza, revierte ni retrasa la accion real. `prepare`
 *     nunca lanza sincronicamente, y la promesa que crea ya lleva su propio
 *     `.catch()` adjunto ANTES de devolverse: aunque el llamador nunca
 *     invoque `persist`, la promesa queda resuelta igualmente (sin
 *     "unhandled rejection").
 *  2. **Sala PRE-ACCION** (§16): `prepare(room, decision)` recibe la MISMA
 *     `room`/`decision` que `CombatDecisionRecorder.tryPrepareHumanDecision`/
 *     `tryPrepareOnline` ya capturan antes de mutar nada. `BattleRoom` es
 *     inmutable en este codebase (cada `applyXxx` devuelve una instancia
 *     nueva), asi que esa referencia sigue siendo un snapshot PRE-ACCION
 *     valido sin importar cuanto tiempo despues se use.
 *
 * Patron de uso en cada caso de uso (`ExecuteBasicAttack`/`UseSkill`/
 * `UseEpic`/`ExecuteAiTurn`), calcado del §17 de la correccion de alcance:
 *
 * ```
 * const decision = this.decisionRecorder?.tryPrepareHumanDecision(room, ...)
 * const pendingLabel = this.liveTeacherLabeler?.prepare(room, decision) ?? null
 * // ... se resuelve y persiste la accion REAL (puede tardar, puede fallar) ...
 * if (decision !== undefined && decision !== null) {
 *   await this.decisionRecorder?.record(decision)       // YA existia
 *   void this.liveTeacherLabeler?.persist(pendingLabel)  // NUNCA se espera
 * }
 * ```
 *
 * `persist` deliberadamente NO se espera en el camino de la respuesta: para
 * cuando se llega a este punto la accion real YA esta persistida (lo unico
 * que se añade es observabilidad), y esperar aqui sumaria la latencia
 * completa de la busqueda MCTS (hasta 128 rollouts) a cada respuesta de
 * combate. Si `persist` falla, su propio try/catch interno lo loguea sin
 * propagar nada al llamador.
 *
 * NUNCA se invoca para una decision MISSION: `RunMissionSimulation` resuelve
 * la mision ENTERA con `MissionSimulation.ts` (motor aproximado propio, sin
 * `BattleRoom`) antes de preparar su `CombatDecisionEvent` retroactivamente;
 * no existe ninguna sala PRE-ACCION que pasarle a `MctsTeacher.teach()` con
 * fidelidad. Fabricar una sala aproximada violaria "el teacher usa el motor
 * real" (ver `docs/en-036-ai-dataset-pipeline.md`).
 */
export class LiveMctsTeacherLabeler {
  constructor(
    private readonly teacher: MctsTeacher,
    private readonly repository: MctsTeacherLabelRepositoryPort,
    private readonly clock: ClockPort,
    private readonly logger: LiveMctsTeacherLabelerLogger,
  ) {}

  /**
   * Debe llamarse ANTES de resolver/persistir la accion real, con la MISMA
   * `room` que se le paso a `CombatDecisionRecorder`. `decision` puede ser
   * `null`/`undefined` (sin `CombatDecisionRecorder` inyectado, o
   * preparacion fallida): en ese caso no hay nada que etiquetar y se
   * devuelve `null`. Tambien devuelve `null` para `END_TURN`: ese cierre
   * tecnico nunca es una decision de politica, nunca genera teacher label.
   */
  prepare(
    room: BattleRoom,
    decision: CombatDecisionEvent | null | undefined,
  ): PendingMctsTeacherLabel | null {
    if (decision === null || decision === undefined) return null
    if (decision.selectedAction.kind === 'END_TURN') return null

    const simulationSeed = deriveLiveTeacherSeed(decision.eventId)
    const result = this.teacher.teach(room, simulationSeed).catch((error: unknown) => {
      this.logFailure(decision, error)
      return null
    })

    return { decision, result }
  }

  /**
   * Espera el resultado ya iniciado por `prepare` y, si existe, lo valida y
   * lo persiste. Nunca lanza. Llamar SOLO despues de confirmar que la
   * decision real se registro con exito (nunca antes de eso).
   */
  async persist(pending: PendingMctsTeacherLabel | null): Promise<void> {
    if (pending === null) return

    const result = await pending.result
    if (result === null) return // el fallo de teach() ya se logueo en prepare()

    try {
      this.validate(pending.decision, result)

      const label: MctsTeacherLabel = {
        schemaVersion: MCTS_TEACHER_LABEL_SCHEMA_VERSION,
        eventId: pending.decision.eventId,
        battleId: pending.decision.battleId,
        decisionSequence: pending.decision.decisionSequence,
        origin: pending.decision.origin,
        mode: pending.decision.mode,
        result,
        generatedAt: this.clock.now(),
      }

      await this.repository.append(label)
    } catch (error: unknown) {
      this.logFailure(pending.decision, error)
    }
  }

  private validate(decision: CombatDecisionEvent, result: MctsTeacherResult): void {
    // Ambos campos son literales `1` hoy (ninguno de los dos contratos tiene
    // todavia una segunda version), asi que TypeScript puede probar que esta
    // comparacion siempre es verdadera -- de ahi el `as number`: el chequeo
    // es una guardia de reproduccion futura (§5), no codigo muerto, y debe
    // seguir evaluandose en tiempo de ejecucion el dia que cualquiera de los
    // dos contratos gane una segunda `schemaVersion`.
    if ((result.stateSchemaVersion as number) !== (decision.stateBefore.schemaVersion as number)) {
      throw new MctsTeacherLabelValidationError(
        `stateSchemaVersion del resultado (${String(result.stateSchemaVersion)}) no coincide ` +
          `con el de la decision (${String(decision.stateBefore.schemaVersion)}).`,
      )
    }

    if (!teacherCandidatesAreSubsetOfLegalActions({ result }, decision.legalActions)) {
      throw new MctsTeacherLabelValidationError(
        'algun candidato del teacher no pertenece a legalActions de la decision.',
      )
    }
  }

  private logFailure(decision: CombatDecisionEvent, error: unknown): void {
    this.logger.error('mcts_teacher_label_generation_failed', {
      eventId: decision.eventId,
      battleId: decision.battleId,
      decisionSequence: decision.decisionSequence,
      reason: error instanceof Error ? error.name : 'unknown',
    })
  }
}
