import type { Collection, Db } from 'mongodb'

import type {
  MissionSimulationIntakeRecord,
  MissionSimulationIntakeRepositoryPort,
} from '../../../application/ports/MissionSimulationIntakeRepositoryPort'
import type { MissionSimulationResult } from '../../../application/services/MissionSimulation'

export const MISSION_SIMULATION_INTAKE_COLLECTION = 'mission-simulation-intake'

interface IntakeDocument {
  readonly _id: string
  readonly requestHash: string
  readonly receivedAt: Date
}

interface ResultDocument {
  readonly _id: string
  readonly requestHash: string
  readonly completedAt: Date
  readonly result: MissionSimulationResult
}

export class MongoMissionSimulationIntakeRepository implements MissionSimulationIntakeRepositoryPort {
  private readonly records: Collection<IntakeDocument>
  private readonly results: Collection<ResultDocument>

  constructor(db: Db) {
    this.records = db.collection<IntakeDocument>(MISSION_SIMULATION_INTAKE_COLLECTION)
    this.results = db.collection<ResultDocument>('mission-simulation-results')
  }

  async insertIfAbsent(
    operationId: string,
    requestHash: string,
  ): Promise<MissionSimulationIntakeRecord> {
    await this.records.updateOne(
      { _id: operationId },
      { $setOnInsert: { _id: operationId, requestHash, receivedAt: new Date() } },
      { upsert: true },
    )

    const stored = await this.records.findOne({ _id: operationId })
    if (stored === null) {
      throw new Error(`La operacion ${operationId} no existe tras reservarla.`)
    }

    return {
      operationId: stored._id,
      requestHash: stored.requestHash,
      receivedAt: stored.receivedAt,
    }
  }

  async resultOf(operationId: string): Promise<MissionSimulationResult | null> {
    return (await this.results.findOne({ _id: operationId }))?.result ?? null
  }

  async saveResultIfAbsent(
    operationId: string,
    requestHash: string,
    result: MissionSimulationResult,
  ): Promise<MissionSimulationResult> {
    const intake = await this.records.findOne({ _id: operationId })
    if (intake?.requestHash !== requestHash)
      throw new Error('La solicitud no coincide con la operacion reservada.')
    await this.results.updateOne(
      { _id: operationId },
      { $setOnInsert: { _id: operationId, requestHash, completedAt: new Date(), result } },
      { upsert: true },
    )
    const stored = await this.results.findOne({ _id: operationId })
    if (stored?.requestHash !== requestHash)
      throw new Error('Resultado de simulacion inconsistente.')
    return stored.result
  }
}
