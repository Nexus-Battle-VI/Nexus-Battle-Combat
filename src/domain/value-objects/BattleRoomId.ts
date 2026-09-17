import { DomainError } from '../errors/DomainError'

/**
 * Identidad de una sala de batalla (HU-14).
 *
 * UUID v4, generado por el servidor via `IdGeneratorPort` — nunca provisto
 * por el cliente (HU-14.1, `HU-14.1-Decisiones-Tecnicas.md`, punto 9). Se usa
 * como `_id` de Mongo directamente, igual que `hero-selections`.
 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class BattleRoomId {
  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: unknown): BattleRoomId {
    if (typeof raw !== 'string' || !UUID_V4_PATTERN.test(raw)) {
      throw new DomainError(`El identificador de sala "${String(raw)}" no es un UUID v4 valido.`)
    }

    return new BattleRoomId(raw)
  }

  equals(other: BattleRoomId): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}
