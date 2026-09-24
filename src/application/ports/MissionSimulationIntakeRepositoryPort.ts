/** Only the request identity is stored until the simulation engine is available. */
export interface MissionSimulationIntakeRecord {
  readonly operationId: string
  readonly requestHash: string
  readonly receivedAt: Date
}

export interface MissionSimulationIntakeRepositoryPort {
  insertIfAbsent(operationId: string, requestHash: string): Promise<MissionSimulationIntakeRecord>
}

export const MISSION_SIMULATION_INTAKE_REPOSITORY = Symbol('MissionSimulationIntakeRepositoryPort')
