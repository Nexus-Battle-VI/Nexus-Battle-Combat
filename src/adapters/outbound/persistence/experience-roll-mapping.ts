import type {
  ExperienceRollBatchSnapshot,
  ExperienceRollRecord,
} from '../../../application/ports/ExperienceRollRepositoryPort'
import { EXPERIENCE_ROLL_FACES } from '../../../domain/reward/ExperienceRollPolicy'

/**
 * Traduccion entre el documento de MongoDB y la instantanea del lote de tiradas
 * (HU-09, Task HU-09.2). Pura y aparte del repositorio, como
 * `battle-room-mapping`: es donde uno se puede equivocar de verdad -- un entero
 * promocionado, una tirada fuera del dado -- y sacarla permite probarla sin
 * contenedor.
 *
 * VALIDA AL LEER, NO SOLO AL ESCRIBIR. El validador del motor cubre el rango de
 * `roll`, pero no que el documento traiga al menos una derrota ni que sus
 * identificadores tengan contenido; un documento corrupto no debe llegar al
 * caso de uso disfrazado de dato bueno. Por eso el documento se lee como dato
 * NO CONFIABLE (`unknown` campo a campo) en lugar de confiar en el tipo.
 */

export class ExperienceRollMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExperienceRollMappingError'
  }
}

export interface ExperienceRollDefeatDocument {
  readonly encounterId: string
  readonly enemyInstanceId: string
  readonly rivalRef: string
  readonly roll: number
  readonly persistedAt: Date
}

export interface ExperienceRollBatchDocument {
  readonly _id: string
  readonly enrollmentId: string
  readonly simulationId: string
  readonly heroId: string
  readonly defeats: readonly ExperienceRollDefeatDocument[]
  readonly createdAt: Date
}

const requireText = (raw: unknown, context: string): string => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ExperienceRollMappingError(`${context} debe ser una cadena con contenido.`)
  }

  return raw
}

const requireDate = (raw: unknown, context: string): Date => {
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) {
    throw new ExperienceRollMappingError(`${context} debe ser una fecha valida.`)
  }

  return raw
}

/**
 * La tirada tiene que caer dentro del dado. Un `roll` fuera de `1..8` es un
 * documento que no debio entrar -- el validador de `013-experience-rolls` lo
 * impide -- y aqui se dice cual, en lugar de devolver una recompensa imposible.
 */
const requireRoll = (raw: unknown, context: string): number => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > EXPERIENCE_ROLL_FACES) {
    throw new ExperienceRollMappingError(
      `${context} debe ser un entero entre 1 y ${String(EXPERIENCE_ROLL_FACES)}: ${String(raw)}.`,
    )
  }

  return raw
}

const toRecord = (raw: unknown, batchId: string, index: number): ExperienceRollRecord => {
  if (typeof raw !== 'object' || raw === null) {
    throw new ExperienceRollMappingError(
      `La derrota ${String(index)} del lote ${batchId} no es un objeto.`,
    )
  }

  const defeat = raw as Record<string, unknown>
  const context = `La derrota ${String(index)} del lote ${batchId}`

  return {
    encounterId: requireText(defeat.encounterId, `El encounterId de ${context}`),
    enemyInstanceId: requireText(defeat.enemyInstanceId, `El enemyInstanceId de ${context}`),
    rivalRef: requireText(defeat.rivalRef, `El rivalRef de ${context}`),
    roll: requireRoll(defeat.roll, `La tirada de ${context}`),
    persistedAt: requireDate(defeat.persistedAt, `El persistedAt de ${context}`),
  }
}

export const toSnapshot = (document: ExperienceRollBatchDocument): ExperienceRollBatchSnapshot => {
  const rawDefeats: unknown = document.defeats

  if (!Array.isArray(rawDefeats) || rawDefeats.length === 0) {
    throw new ExperienceRollMappingError(
      `El lote ${document._id} no trae ninguna derrota: un lote vacio no deberia existir.`,
    )
  }

  return {
    operationId: requireText(document._id, 'El identificador del lote'),
    enrollmentId: requireText(document.enrollmentId, `El enrollmentId del lote ${document._id}`),
    simulationId: requireText(document.simulationId, `El simulationId del lote ${document._id}`),
    heroId: requireText(document.heroId, `El heroId del lote ${document._id}`),
    defeats: (rawDefeats as readonly unknown[]).map((raw, index) =>
      toRecord(raw, document._id, index),
    ),
    createdAt: requireDate(document.createdAt, `El createdAt del lote ${document._id}`),
  }
}

export const toDocument = (snapshot: ExperienceRollBatchSnapshot): ExperienceRollBatchDocument => ({
  _id: snapshot.operationId,
  enrollmentId: snapshot.enrollmentId,
  simulationId: snapshot.simulationId,
  heroId: snapshot.heroId,
  defeats: snapshot.defeats.map((defeat) => ({
    encounterId: defeat.encounterId,
    enemyInstanceId: defeat.enemyInstanceId,
    rivalRef: defeat.rivalRef,
    roll: defeat.roll,
    persistedAt: defeat.persistedAt,
  })),
  createdAt: snapshot.createdAt,
})
