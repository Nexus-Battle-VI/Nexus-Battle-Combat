import { DomainError } from './DomainError'
import type { AiModelState } from '../value-objects/AiModelState'

/**
 * Errores del model registry de IA (EN-037.1, Management #570). El
 * registry NUNCA filtra detalles de Mongo (`E11000`, `Binary`,
 * `ObjectId`) a application/domain -- todo mapeado aqui.
 */

export class InvalidModelStateTransitionError extends DomainError {
  constructor(from: AiModelState, to: AiModelState) {
    super(`Transicion de estado invalida: "${from}" -> "${to}".`)
    this.name = 'InvalidModelStateTransitionError'
  }
}

/** Conflicto de concurrencia optimista (revision obsoleta) o de lineage inmutable en un reintento. */
export class ModelVersionConflictError extends DomainError {
  constructor(reason: string) {
    super(`Conflicto al escribir la version del modelo: ${reason}`)
    this.name = 'ModelVersionConflictError'
  }
}

/** Dos activaciones concurrentes: como maximo una puede ganar (indice unico parcial ACTIVE). */
export class ActiveModelConflictError extends DomainError {
  constructor() {
    super('Ya existe una version ACTIVE: la activacion concurrente fue rechazada.')
    this.name = 'ActiveModelConflictError'
  }
}

/** Mismo hash de artefacto, bytes distintos -- nunca sobrescribe un artefacto content-addressed. */
export class ArtifactConflictError extends DomainError {
  constructor(sha256: string) {
    super(`El artefacto "${sha256}" ya existe con bytes distintos (conflicto content-addressed).`)
    this.name = 'ArtifactConflictError'
  }
}

export class ModelArtifactHashMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(
      `El SHA-256 real del artefacto ("${actual}") no coincide con el declarado ("${expected}").`,
    )
    this.name = 'ModelArtifactHashMismatchError'
  }
}

export class ModelArtifactNotFoundError extends DomainError {
  constructor(sha256: string) {
    super(`No existe un artefacto registrado con sha256="${sha256}".`)
    this.name = 'ModelArtifactNotFoundError'
  }
}

export class ModelArtifactTooLargeError extends DomainError {
  constructor(sizeBytes: number, limitBytes: number) {
    super(
      `artifact too large for selected storage strategy: ${String(sizeBytes)} bytes > ` +
        `${String(limitBytes)} bytes.`,
    )
    this.name = 'ModelArtifactTooLargeError'
  }
}

export class ModelSchemaIncompatibleError extends DomainError {
  constructor(reason: string) {
    super(`El manifest no es compatible con el contrato de runtime vigente: ${reason}`)
    this.name = 'ModelSchemaIncompatibleError'
  }
}
