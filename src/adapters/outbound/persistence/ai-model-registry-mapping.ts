import { Int32 } from 'mongodb'

import {
  AiModelVersion,
  type AiModelArtifactLineage,
  type AiModelRejection,
  type AiModelStateHistoryEntry,
  type AiModelTrainingLineage,
} from '../../../domain/entities/AiModelVersion'
import type { AiModelState } from '../../../domain/value-objects/AiModelState'

export const AI_MODEL_REGISTRY_SCHEMA_VERSION = 1

export interface AiModelVersionDocument {
  readonly _id: string
  readonly schemaVersion: number
  readonly state: AiModelState
  readonly revision: Int32
  readonly trainingLineage: AiModelTrainingLineage
  readonly artifactLineage: AiModelArtifactLineage | null
  readonly stateHistory: readonly AiModelStateHistoryEntry[]
  readonly rejection: AiModelRejection | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export const toDocument = (version: AiModelVersion): AiModelVersionDocument => {
  const props = version.toProps()

  return {
    _id: version.modelVersion,
    schemaVersion: AI_MODEL_REGISTRY_SCHEMA_VERSION,
    state: props.state,
    revision: new Int32(props.revision),
    trainingLineage: props.trainingLineage,
    artifactLineage: props.artifactLineage,
    stateHistory: props.stateHistory,
    rejection: props.rejection,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  }
}

export const toAiModelVersion = (document: AiModelVersionDocument): AiModelVersion =>
  AiModelVersion.restore({
    trainingLineage: document.trainingLineage,
    artifactLineage: document.artifactLineage,
    state: document.state,
    revision: document.revision.valueOf(),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    stateHistory: document.stateHistory,
    rejection: document.rejection,
  })

const canonicalJson = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

/**
 * Identidad semantica de un `trainingLineage` repetido (#570 §52, mismo
 * criterio que `sameMctsTeacherLabel`): dos registros para el mismo
 * `modelVersion` con lineage de training IDENTICO son el mismo evento de
 * creacion (no-op); con lineage distinto son un conflicto -- jamas se
 * sobreescribe metadata inmutable (#570 §49).
 */
export const sameTrainingLineage = (
  left: AiModelTrainingLineage,
  right: AiModelTrainingLineage,
): boolean => canonicalJson(left) === canonicalJson(right)
