import { InvalidRewardError } from '../errors/BattleRoomErrors'

export interface RewardConfigSnapshot {
  readonly amount: number
}

/**
 * Recompensa configurada de una sala de batalla (RF-14/CA-01: "recompensa
 * configurada").
 *
 * Conserva UNICAMENTE `amount: number >= 0`. No fija `type`, moneda ni
 * catalogo: RF-14 no confirma un tipo cerrado, y RF-23 (apuesta de creditos,
 * HU-23) es una historia separada y posterior que no se puede dar por
 * identica a este campo sin confirmacion del Product Owner — HU-14.1,
 * `HU-14.1-Decisiones-Tecnicas.md`, punto 6.
 *
 * Se lanza `InvalidRewardError` (subclase de `DomainError` en
 * `domain/errors/BattleRoomErrors.ts`, no una clase de `application/errors`)
 * porque el propio dominio puede determinar la violacion por completo con el
 * valor recibido, sin ninguna dependencia externa. Sigue siendo una regla de
 * negocio (422 en el controlador), no un error de formato (400) — eso no
 * cambia con la reubicacion, solo la capa en la que vive la clase.
 */
export class RewardConfig {
  readonly amount: number

  private constructor(amount: number) {
    this.amount = amount
  }

  static create(amount: unknown): RewardConfig {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new InvalidRewardError(amount)
    }

    return new RewardConfig(amount)
  }

  toSnapshot(): RewardConfigSnapshot {
    return { amount: this.amount }
  }
}
