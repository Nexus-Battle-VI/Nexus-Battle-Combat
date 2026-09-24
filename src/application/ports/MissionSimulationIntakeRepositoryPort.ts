import type { MissionSimulationResult } from '../services/MissionSimulation'

/** Identity and result are durable; a retry returns the original result. */
export interface MissionSimulationIntakeRecord {
  readonly operationId: string
  readonly requestHash: string
  readonly receivedAt: Date
}

export interface MissionSimulationIntakeRepositoryPort {
  insertIfAbsent(operationId: string, requestHash: string): Promise<MissionSimulationIntakeRecord>
  resultOf(operationId: string): Promise<MissionSimulationResult | null>
  saveResultIfAbsent(
    operationId: string,
    requestHash: string,
    result: MissionSimulationResult,
  ): Promise<MissionSimulationResult>
}

export const MISSION_SIMULATION_INTAKE_REPOSITORY = Symbol('MissionSimulationIntakeRepositoryPort')
