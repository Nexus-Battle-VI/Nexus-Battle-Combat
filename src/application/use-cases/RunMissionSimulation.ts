import type { MissionSimulationIntakeRepositoryPort } from '../ports/MissionSimulationIntakeRepositoryPort'
import type { RandomSequenceFactoryPort } from '../ports/RandomSequencePort'
import type { MissionSeedPort } from '../ports/MissionSeedPort'
import {
  simulateMission,
  type MissionSimulationRequest,
  type MissionSimulationResult,
} from '../services/MissionSimulation'

/** All combat facts are calculated once and persisted before returning to Missions. */
export class RunMissionSimulation {
  constructor(
    private readonly repository: MissionSimulationIntakeRepositoryPort,
    private readonly sequences: RandomSequenceFactoryPort,
    private readonly seeds: MissionSeedPort,
  ) {}

  async execute(
    request: MissionSimulationRequest,
    requestHash: string,
  ): Promise<MissionSimulationResult> {
    const stored = await this.repository.resultOf(request.operationId)
    if (stored !== null) return stored
    const result = simulateMission(
      request,
      this.seeds.forOperation(request.operationId),
      this.sequences,
    )
    return this.repository.saveResultIfAbsent(request.operationId, requestHash, result)
  }
}
