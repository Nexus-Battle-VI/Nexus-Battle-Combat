import { randomUUID } from 'node:crypto'

import type { IdGeneratorPort } from '../../../application/ports/IdGeneratorPort'

/**
 * Generador de identificadores basado en UUID v4 de la biblioteca estandar de
 * Node. No requiere dependencias externas. Mismo patron que
 * `UuidGenerator.ts` de Player-Inventory.
 */
export class UuidGenerator implements IdGeneratorPort {
  generate(): string {
    return randomUUID()
  }
}
