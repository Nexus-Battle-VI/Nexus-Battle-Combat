import { MissionSimulationOperationReusedError } from '../errors/MissionSimulationIntakeErrors'
import type { MissionSimulationIntakeRepositoryPort } from '../ports/MissionSimulationIntakeRepositoryPort'

/**
 * Reserves the idempotency key before any future combat work. A matching retry
 * remains eligible for execution; a different body must never reuse the key.
 */
export class AcceptMissionSimulationRequest {
  constructor(private readonly repository: MissionSimulationIntakeRepositoryPort) {}

  async execute(operationId: string, requestHash: string): Promise<void> {
    const stored = await this.repository.insertIfAbsent(operationId, requestHash)

    if (stored.requestHash !== requestHash) {
      throw new MissionSimulationOperationReusedError(operationId)
    }
  }
}
