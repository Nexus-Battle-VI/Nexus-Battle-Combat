import type {
  MissionSimulationIntakeRecord,
  MissionSimulationIntakeRepositoryPort,
} from '../../../application/ports/MissionSimulationIntakeRepositoryPort'

export class InMemoryMissionSimulationIntakeRepository implements MissionSimulationIntakeRepositoryPort {
  private readonly records = new Map<string, MissionSimulationIntakeRecord>()

  insertIfAbsent(operationId: string, requestHash: string): Promise<MissionSimulationIntakeRecord> {
    const existing = this.records.get(operationId)
    if (existing !== undefined) return Promise.resolve(existing)

    const record = { operationId, requestHash, receivedAt: new Date() }
    this.records.set(operationId, record)
    return Promise.resolve(record)
  }
}
