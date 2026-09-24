import type { Collection, Db } from 'mongodb'

import type {
  MissionSimulationIntakeRecord,
  MissionSimulationIntakeRepositoryPort,
} from '../../../application/ports/MissionSimulationIntakeRepositoryPort'

export const MISSION_SIMULATION_INTAKE_COLLECTION = 'mission-simulation-intake'

interface IntakeDocument {
  readonly _id: string
  readonly requestHash: string
  readonly receivedAt: Date
}

export class MongoMissionSimulationIntakeRepository implements MissionSimulationIntakeRepositoryPort {
  private readonly records: Collection<IntakeDocument>

  constructor(db: Db) {
    this.records = db.collection<IntakeDocument>(MISSION_SIMULATION_INTAKE_COLLECTION)
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
}
