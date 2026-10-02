import { Int32, type Collection, type Db } from 'mongodb'

import {
  battleDropWorkflowId,
  type BattleDropWorkflow,
  type BattleDropWorkflowIntent,
  type BattleDropWorkflowRepositoryPort,
} from '../../../application/ports/BattleDropWorkflowRepositoryPort'
import type { BattleDropTransferReceipt } from '../../../application/ports/BattleDropInventoryPort'

interface WorkflowDocument extends Omit<BattleDropWorkflow, 'defeatEventSeq'> {
  readonly _id: string
  readonly defeatEventSeq: Int32 | number
  readonly createdAt: Date
  readonly updatedAt: Date
}

const toWorkflow = (document: WorkflowDocument): BattleDropWorkflow => ({
  id: document._id,
  battleId: document.battleId,
  defeatEventSeq: Number(document.defeatEventSeq),
  killerPlayerId: document.killerPlayerId,
  defeatedPlayerId: document.defeatedPlayerId,
  resolution: document.resolution,
  state: document.state,
  receipt: document.receipt,
  winnerNotified: document.winnerNotified,
  loserNotified: document.loserNotified,
})

export class MongoBattleDropWorkflowRepository implements BattleDropWorkflowRepositoryPort {
  private readonly workflows: Collection<WorkflowDocument>
  private readonly settled: Collection<{ _id: string; closedAt: Date }>

  constructor(db: Db) {
    this.workflows = db.collection<WorkflowDocument>('battle-drop-workflows')
    this.settled = db.collection<{ _id: string; closedAt: Date }>('battle-drop-settlements')
  }

  async findById(id: string): Promise<BattleDropWorkflow | null> {
    const document = await this.workflows.findOne({ _id: id })
    return document === null ? null : toWorkflow(document)
  }

  async createIfAbsent(intent: BattleDropWorkflowIntent): Promise<BattleDropWorkflow> {
    const id = battleDropWorkflowId(intent.battleId, intent.defeatEventSeq)
    const now = new Date()
    const state = intent.resolution.status
    await this.workflows.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          id,
          ...intent,
          // El esquema exige BSON `int`: un numero JS plano serializa como
          // `double` y la validacion del driver lo rechazaria.
          defeatEventSeq: new Int32(intent.defeatEventSeq),
          state,
          receipt: null,
          winnerNotified: false,
          loserNotified: false,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    )
    const workflow = await this.findById(id)
    if (workflow === null) throw new Error('El derecho de drop no se pudo recuperar.')
    return workflow
  }

  async findUnsettled(limit: number): Promise<readonly BattleDropWorkflow[]> {
    const documents = await this.workflows
      .find({ state: { $in: ['PENDING', 'FAILED_RETRYABLE'] } })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray()
    return documents.map(toWorkflow)
  }

  async findUnnotified(limit: number): Promise<readonly BattleDropWorkflow[]> {
    const documents = await this.workflows
      .find({ state: 'CREDITED', $or: [{ winnerNotified: false }, { loserNotified: false }] })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray()
    return documents.map(toWorkflow)
  }

  async markCredited(id: string, receipt: BattleDropTransferReceipt): Promise<void> {
    await this.workflows.updateOne(
      { _id: id, state: { $in: ['PENDING', 'FAILED_RETRYABLE'] } },
      { $set: { state: 'CREDITED', receipt, updatedAt: new Date() } },
    )
  }

  async markFailed(id: string): Promise<void> {
    await this.workflows.updateOne(
      { _id: id, state: { $in: ['PENDING', 'FAILED_RETRYABLE'] } },
      { $set: { state: 'FAILED_RETRYABLE', updatedAt: new Date() } },
    )
  }

  async markNotified(id: string, role: 'winner' | 'loser'): Promise<void> {
    await this.workflows.updateOne(
      { _id: id, state: 'CREDITED' },
      {
        $set: {
          [role === 'winner' ? 'winnerNotified' : 'loserNotified']: true,
          updatedAt: new Date(),
        },
      },
    )
  }

  async isBattleClosed(battleId: string): Promise<boolean> {
    return (await this.settled.findOne({ _id: battleId })) !== null
  }

  async markBattleClosed(battleId: string): Promise<void> {
    await this.settled.updateOne(
      { _id: battleId },
      { $setOnInsert: { closedAt: new Date() } },
      { upsert: true },
    )
  }
}
