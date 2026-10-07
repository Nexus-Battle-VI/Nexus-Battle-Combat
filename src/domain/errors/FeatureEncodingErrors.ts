import { DomainError } from './DomainError'

/**
 * Espejo exacto de `nexus_combat_ai.errors` (Python, EN-036.2 #566): dato
 * corrupto o categoria fuera del vocabulario congelado de `feature-schema-v1`
 * FALLA explicito, nunca se corrige en silencio (sin ceros de relleno, sin
 * "ultimo bucket" para una categoria desconocida). `FeatureEncoderV1`
 * (EN-036.4 #568) lanza estos mismos dos errores que su contraparte Python.
 */

export class UnsupportedFeatureCategoryError extends DomainError {
  constructor(reason: string) {
    super(
      `${reason} no esta en el vocabulario congelado de feature-schema-v1. ` +
        'Una categoria nueva exige feature-schema-v2.',
    )
    this.name = 'UnsupportedFeatureCategoryError'
  }
}

export class MissingReferencedEntityError extends DomainError {
  constructor(reason: string) {
    super(reason)
    this.name = 'MissingReferencedEntityError'
  }
}
