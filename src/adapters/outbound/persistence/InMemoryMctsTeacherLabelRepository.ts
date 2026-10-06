import { MctsTeacherLabelConflictError } from '../../../domain/errors/MctsErrors'
import type { MctsTeacherLabel } from '../../../domain/decision/MctsTeacherLabel'
import type { MctsTeacherLabelRepositoryPort } from '../../../application/ports/MctsTeacherLabelRepositoryPort'
import { sameMctsTeacherLabel } from './mcts-teacher-label-mapping'

export class InMemoryMctsTeacherLabelRepository implements MctsTeacherLabelRepositoryPort {
  private readonly labels = new Map<string, MctsTeacherLabel>()

  append(label: MctsTeacherLabel): Promise<void> {
    const existing = this.labels.get(label.eventId)

    if (existing !== undefined) {
      if (!sameMctsTeacherLabel(existing, label)) {
        return Promise.reject(new MctsTeacherLabelConflictError(label.eventId))
      }

      return Promise.resolve()
    }

    this.labels.set(label.eventId, label)
    return Promise.resolve()
  }

  findByEventId(eventId: string): Promise<MctsTeacherLabel | null> {
    return Promise.resolve(this.labels.get(eventId) ?? null)
  }
}
