export class InvalidMissionSimulationRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMissionSimulationRequestError'
  }
}

export class MissionSimulationOperationReusedError extends Error {
  constructor(operationId: string) {
    super(`La operacion ${operationId} ya se recibio con otro cuerpo.`)
    this.name = 'MissionSimulationOperationReusedError'
  }
}
