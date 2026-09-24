/** Private, repeatable seed material for one mission operation. */
export interface MissionSeed {
  readonly value: number
  readonly seedRef: string
  readonly simulationId: string
}

export interface MissionSeedPort {
  forOperation(operationId: string): MissionSeed
}
