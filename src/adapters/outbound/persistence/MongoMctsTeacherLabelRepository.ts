import { MongoServerError, type Collection, type Db } from 'mongodb'

import { MctsTeacherLabelConflictError } from '../../../domain/errors/MctsErrors'
import type { MctsTeacherLabel } from '../../../domain/decision/MctsTeacherLabel'
import type { MctsTeacherLabelRepositoryPort } from '../../../application/ports/MctsTeacherLabelRepositoryPort'
import {
  sameMctsTeacherLabel,
  toMctsTeacherLabel,
  toMctsTeacherLabelDocument,
  type MctsTeacherLabelDocument,
} from './mcts-teacher-label-mapping'

export const MCTS_TEACHER_LABELS_COLLECTION = 'mcts-teacher-labels'

/** Persistencia append-only con `_id = eventId`; un duplicado nunca sobrescribe. */
export class MongoMctsTeacherLabelRepository implements MctsTeacherLabelRepositoryPort {
  private readonly labels: Collection<MctsTeacherLabelDocument>

  constructor(db: Db) {
    this.labels = db.collection<MctsTeacherLabelDocument>(MCTS_TEACHER_LABELS_COLLECTION)
  }

  async append(label: MctsTeacherLabel): Promise<void> {
    try {
      await this.labels.insertOne(toMctsTeacherLabelDocument(label))
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error

      const stored = await this.labels.findOne({ _id: label.eventId })

      if (stored === null || !sameMctsTeacherLabel(toMctsTeacherLabel(stored), label)) {
        throw new MctsTeacherLabelConflictError(label.eventId)
      }
    }
  }

  async findByEventId(eventId: string): Promise<MctsTeacherLabel | null> {
    const document = await this.labels.findOne({ _id: eventId })

    return document === null ? null : toMctsTeacherLabel(document)
  }
}
