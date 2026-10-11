import type { MissionSimulationIntakeRepositoryPort } from '../ports/MissionSimulationIntakeRepositoryPort'
import type { RandomSequenceFactoryPort } from '../ports/RandomSequencePort'
import type { MissionSeedPort } from '../ports/MissionSeedPort'
import type { AiDecisionPort } from '../ports/AiDecisionPort'
import {
  simulateMission,
  type MissionDecisionObservation,
  type MissionSimulationRequest,
  type MissionSimulationResult,
} from '../services/MissionSimulation'
import type {
  CombatDecisionSource,
  CombatDecisionTelemetryEvent,
} from '../../domain/decision/CombatDecisionEvent'
import { BattleMode } from '../../domain/value-objects/BattleMode'
import type { CombatDecisionRecorder } from '../services/CombatDecisionRecorder'

export interface DecisionPolicyBinding {
  readonly policy: AiDecisionPort
  readonly source: CombatDecisionSource
}

/** All combat facts are calculated once and persisted before returning to Missions. */
export class RunMissionSimulation {
  constructor(
    private readonly repository: MissionSimulationIntakeRepositoryPort,
    private readonly sequences: RandomSequenceFactoryPort,
    private readonly seeds: MissionSeedPort,
    private readonly decisionPolicy: DecisionPolicyBinding,
    private readonly decisionRecorder: CombatDecisionRecorder | null = null,
  ) {}

  async execute(
    request: MissionSimulationRequest,
    requestHash: string,
  ): Promise<MissionSimulationResult> {
    const stored = await this.repository.resultOf(request.operationId)
    if (stored !== null) return stored
    const decisions: MissionDecisionObservation[] = []
    const result = await simulateMission(
      request,
      this.seeds.forOperation(request.operationId),
      this.sequences,
      this.decisionPolicy.policy,
      (decision) => decisions.push(decision),
    )
    const saved = await this.repository.saveResultIfAbsent(request.operationId, requestHash, result)

    if (this.decisionRecorder !== null) {
      const recorder = this.decisionRecorder
      const events: CombatDecisionTelemetryEvent[] = decisions.flatMap((decision) => {
        const event = recorder.tryPrepareMission({
          battleId: request.operationId,
          decisionSequence: decision.decisionSequence,
          mode: BattleMode.Pve,
          actor: decision.stateBefore.actor.identity,
          decisionSource:
            decision.selectedAction.kind === 'END_TURN' ? 'SYSTEM' : this.decisionPolicy.source,
          stateBefore: decision.stateBefore,
          legalActions: decision.legalActions,
          selectedAction: decision.selectedAction,
        })

        return event === null ? [] : [event]
      })
      const outcome = recorder.tryPrepareOutcome({
        origin: 'MISSION',
        battleId: request.operationId,
        mode: BattleMode.Pve,
        outcome: { kind: 'MISSION', outcome: saved.combatOutcome },
      })
      if (outcome !== null) events.push(outcome)
      if (events.length > 0) await recorder.recordMany(events)
    }

    return saved
  }
}
