import { createHash } from 'node:crypto'
import { InMemoryMctsSimulationAdapter } from '../../adapters/outbound/system/InMemoryMctsSimulationAdapter'
import { BattleDecisionStateAssembler } from '../../application/services/BattleDecisionStateAssembler'
import { LegalActionGenerator } from '../../application/services/LegalActionGenerator'
import type { ClockPort } from '../../application/ports/ClockPort'
import type { RandomSequencePort } from '../../application/ports/RandomSequencePort'
import { resolveLegalAction } from '../../domain/decision/ActionIdentity'
import {
  IllegalActionIntentError,
  NoLegalDecisionActionsError,
} from '../../domain/errors/DecisionContractErrors'
import type { BattleRoom } from '../../domain/entities/BattleRoom'
import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import {
  NeuralInferenceError,
  NeuralInferenceOutputError,
  NeuralInferenceTimeoutError,
  NeuralRuntimeUnavailableError,
} from '../../domain/errors/NeuralPolicyErrors'
import { NoStrategicMctsCandidatesError } from '../../domain/errors/MctsErrors'
import { EVALUATION_TEAM_A_LABEL, EVALUATION_TEAM_B_LABEL } from './EvaluationBattleFactory'
import { EvaluationMetricsCollector } from './EvaluationMetricsCollector'
import {
  EVALUATION_MATCH_RESULT_VERSION,
  type EvaluationMatchResultV1,
  type EvaluationPolicyFailureCode,
} from './EvaluationMatchResult'
import type { EvaluationPolicy } from '../policies/EvaluationPolicy'
import type { EvaluationSide } from '../experiment/EvaluationSeedSchedule'

export interface RunAcceleratedBattleOptions {
  readonly evaluationId: string
  readonly matchId: string
  readonly mirrorPairId: string
  readonly mirrorLeg: 'LEG_1' | 'LEG_2'
  readonly matchupId: string
  readonly scenarioId: string
  readonly matchSeed: number
  readonly combatSeed: number
  readonly room: BattleRoom
  readonly policyA: EvaluationPolicy
  readonly policyB: EvaluationPolicy
  readonly combatSequence: RandomSequencePort
  readonly clock: ClockPort
  readonly maxPlies: number
}

/** Mapea el error real de una politica a un codigo de fallo explicito (#569 §56). Nunca "loss". */
const mapPolicyFailureCode = (
  policyId: EvaluationPolicy['id'],
  error: unknown,
): EvaluationPolicyFailureCode => {
  if (error instanceof NeuralInferenceTimeoutError) return 'NEURAL_TIMEOUT'
  if (error instanceof NeuralRuntimeUnavailableError) return 'NEURAL_RUNTIME_ERROR'
  if (error instanceof NeuralInferenceOutputError || error instanceof NeuralInferenceError) {
    return 'NEURAL_INFERENCE_OUTPUT_ERROR'
  }
  if (error instanceof NoStrategicMctsCandidatesError) return 'MCTS_NO_STRATEGIC_CANDIDATES'

  switch (policyId) {
    case 'MCTS':
      return 'MCTS_POLICY_ERROR'
    case 'RANDOM':
      return 'RANDOM_POLICY_ERROR'
    case 'RULE_BASED':
      return 'RULE_BASED_POLICY_ERROR'
    case 'NEURAL':
      return 'NEURAL_RUNTIME_ERROR'
  }
}

/**
 * Orquesta UNA partida acelerada (EN-036.5, Management #569 §9-10, §42):
 * el arnes NO implementa un segundo motor -- cada paso pasa por
 * `LegalActionGenerator` REAL, la politica bajo evaluacion, y
 * `InMemoryMctsSimulationAdapter` (los MISMOS casos de uso REALES de
 * Combat, aislados y sin publicar/persistir, #569 §10-11).
 */
export const runAcceleratedBattle = async (
  options: RunAcceleratedBattleOptions,
): Promise<EvaluationMatchResultV1> => {
  const legalActionGenerator = new LegalActionGenerator()
  const stateAssembler = new BattleDecisionStateAssembler()
  const simulation = new InMemoryMctsSimulationAdapter(options.clock)

  const policyByLabel: Record<string, { policy: EvaluationPolicy; side: EvaluationSide }> = {
    [EVALUATION_TEAM_A_LABEL]: { policy: options.policyA, side: 'A' },
    [EVALUATION_TEAM_B_LABEL]: { policy: options.policyB, side: 'B' },
  }

  const metrics = new EvaluationMetricsCollector(
    { A: EVALUATION_TEAM_A_LABEL, B: EVALUATION_TEAM_B_LABEL },
    options.room.battle?.combatants ?? [],
  )

  // `BattleRoom.assertValidCommandId` exige <= 100 caracteres (#569 §43):
  // `evaluationId:matchId` concatenados sin mas superan eso facilmente, asi
  // que el prefijo por partida se resume a un hash corto -- determinista,
  // nunca aleatorio, y unico por partida en la practica (16 hex = 64 bits).
  const commandIdPrefix = createHash('sha256')
    .update(`${options.evaluationId}:${options.matchId}`)
    .digest('hex')
    .slice(0, 16)

  let room = options.room
  let plies = 0
  let decisionCount = 0
  let invalidPolicySelections = 0
  let engineRejections = 0
  let status: EvaluationMatchResultV1['status'] = 'COMPLETED'
  let policyFailureCode: EvaluationPolicyFailureCode | null = null
  let failedSide: EvaluationSide | null = null

  while (room.status === BattleRoomStatus.InBattle) {
    if (plies >= options.maxPlies) {
      status = 'MAX_PLIES'
      break
    }

    const commandId = `cmd:${commandIdPrefix}:${String(plies)}`
    const legalActions = legalActionGenerator.generateAvailable(room)

    if (legalActions.length === 0) {
      const step = await simulation.applyEndTurn(room, commandId)
      room = step.room
      metrics.recordSystemEndTurn()
      metrics.recordEvent(step.event)
      plies += 1
      continue
    }

    const actorKey = room.battle?.currentEntry
    if (actorKey === undefined) {
      throw new NoLegalDecisionActionsError()
    }

    const binding = policyByLabel[actorKey.teamLabel]
    if (binding === undefined) {
      throw new NoLegalDecisionActionsError()
    }

    const state = stateAssembler.assemble(room)

    let selected
    try {
      selected = await binding.policy.decide({
        room,
        state,
        legalActions,
        matchSeed: options.matchSeed,
        decisionIndex: decisionCount,
        side: binding.side,
      })
    } catch (error) {
      failedSide = binding.side
      if (error instanceof IllegalActionIntentError) {
        invalidPolicySelections += 1
        status = 'INVARIANT_VIOLATION'
      } else {
        status = 'POLICY_FAILURE'
        policyFailureCode = mapPolicyFailureCode(binding.policy.id, error)
      }
      break
    }

    // Defensa en profundidad (#569 §23-24): el runner SIEMPRE revalida,
    // nunca confia ciegamente en lo que la politica devolvio, aunque cada
    // envoltorio ya resuelva internamente.
    try {
      resolveLegalAction(selected, legalActions)
    } catch {
      invalidPolicySelections += 1
      status = 'INVARIANT_VIOLATION'
      failedSide = binding.side
      break
    }

    metrics.recordDecision(binding.side, selected)
    decisionCount += 1

    let step
    try {
      step = await simulation.applyAction(
        room,
        actorKey,
        selected,
        commandId,
        options.combatSequence,
      )
    } catch {
      engineRejections += 1
      status = 'ENGINE_FAILURE'
      break
    }

    metrics.recordEvent(step.event)
    room = step.room
    plies += 1

    if (step.finished || room.status === BattleRoomStatus.Finished) {
      break
    }
  }

  const snapshot = metrics.snapshot()
  const result = room.result

  return {
    schemaVersion: EVALUATION_MATCH_RESULT_VERSION,
    evaluationId: options.evaluationId,
    matchId: options.matchId,
    mirrorPairId: options.mirrorPairId,
    mirrorLeg: options.mirrorLeg,
    matchupId: options.matchupId,
    scenarioId: options.scenarioId,
    matchSeed: options.matchSeed,
    combatSeed: options.combatSeed,
    policyA: options.policyA.id,
    policyB: options.policyB.id,
    status,
    policyFailureCode,
    failedSide,
    outcome:
      status === 'COMPLETED' && result !== null
        ? {
            outcome: result.outcome,
            winnerSide:
              result.winnerTeamLabel === null
                ? null
                : result.winnerTeamLabel === EVALUATION_TEAM_A_LABEL
                  ? 'A'
                  : 'B',
            reason: result.reason,
          }
        : null,
    plies,
    decisionCount,
    systemEndTurns: snapshot.systemEndTurns,
    invalidPolicySelections,
    engineRejections,
    metricsBySide: {
      A: sideMetrics('A', snapshot, result),
      B: sideMetrics('B', snapshot, result),
    },
  }
}

const sideMetrics = (
  side: EvaluationSide,
  snapshot: ReturnType<EvaluationMetricsCollector['snapshot']>,
  result: BattleRoom['result'],
): EvaluationMatchResultV1['metricsBySide'][EvaluationSide] => {
  const teamLabel = side === 'A' ? EVALUATION_TEAM_A_LABEL : EVALUATION_TEAM_B_LABEL
  const team = result?.teams.find((candidate) => candidate.teamLabel === teamLabel) ?? null

  return {
    damageDealt: snapshot.damageDealtBySide[side],
    healingDone: snapshot.healingDoneBySide[side],
    decisions: snapshot.decisionsBySide[side],
    actionKindCount: snapshot.actionKindCountBySide[side],
    finalPower: snapshot.finalPowerBySide[side],
    // `BattleResult.teams[].lifePercent` es un PORCENTAJE 0..100 (ver
    // `requireLifePercent` en `BattleResult.ts`); `EvaluationSideMetrics`
    // lo normaliza a razon 0..1 para que `EvaluationReport.ts` (que SI
    // formatea como "%", `pct()`) nunca lo multiplique dos veces.
    finalHealth:
      team === null
        ? null
        : {
            remaining: team.remainingHealth,
            max: team.maxHealth,
            lifePercent: team.lifePercent / 100,
          },
  }
}
