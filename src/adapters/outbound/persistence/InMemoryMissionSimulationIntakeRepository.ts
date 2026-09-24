import type {
  MissionSimulationIntakeRecord,
  MissionSimulationIntakeRepositoryPort,
} from '../../../application/ports/MissionSimulationIntakeRepositoryPort'
import type { MissionSimulationResult } from '../../../application/services/MissionSimulation'

export class InMemoryMissionSimulationIntakeRepository implements MissionSimulationIntakeRepositoryPort {
  private readonly records = new Map<string, MissionSimulationIntakeRecord>()
  private readonly results = new Map<string, MissionSimulationResult>()

  insertIfAbsent(operationId: string, requestHash: string): Promise<MissionSimulationIntakeRecord> {
    const existing = this.records.get(operationId)
    if (existing !== undefined) return Promise.resolve(existing)

    const record = { operationId, requestHash, receivedAt: new Date() }
    this.records.set(operationId, record)
    return Promise.resolve(record)
  }

  resultOf(operationId: string): Promise<MissionSimulationResult | null> {
    return Promise.resolve(this.results.get(operationId) ?? null)
  }

  saveResultIfAbsent(
    operationId: string,
    requestHash: string,
    result: MissionSimulationResult,
  ): Promise<MissionSimulationResult> {
    if (this.records.get(operationId)?.requestHash !== requestHash) {
      return Promise.reject(new Error('La solicitud no coincide con la operacion reservada.'))
    }
    const stored = this.results.get(operationId)
    if (stored !== undefined) return Promise.resolve(stored)
    this.results.set(operationId, result)
    return Promise.resolve(result)
  }
}
