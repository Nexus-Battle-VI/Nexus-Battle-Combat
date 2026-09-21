import { DomainError } from '../errors/DomainError'
import { createCombatProfile, type CombatProfile } from './CombatProfile'

/** Identidad estable de un participante dentro de la batalla: la misma `memberKey` de HU-17. */
export interface CombatantKey {
  readonly teamLabel: string
  readonly seat: number
}

export interface CombatantSnapshot extends CombatantKey {
  /** `null` cuando el participante no tiene perfil de combate (`AI`). */
  readonly currentHealth: number | null
  readonly profile: CombatProfile | null
}

/** Vida de un participante tal como la ve un cliente. */
export interface HealthView {
  readonly current: number
  readonly max: number
}

/** Un participante tal como lo ve un cliente: solo su Vida, nunca su perfil. */
export interface CombatantView extends CombatantKey {
  /** `null` sin perfil de combate (`AI` o batalla anterior a HU-18). */
  readonly health: HealthView | null
}

/**
 * Estado runtime de UN participante durante la batalla (HU-18): su perfil
 * congelado y su Vida actual. INMUTABLE: recibir dano devuelve otro `Combatant`.
 *
 * Combat es la fuente de verdad de la Vida durante la batalla; Player-Inventory
 * conserva la configuracion fuera de ella y no guarda la Vida de cada golpe.
 *
 * Invariante: `0 <= currentHealth <= maxHealth`. Un participante sin perfil
 * (`AI`: no existe fuente autoritativa de sus estadisticas y no se inventan)
 * tampoco tiene Vida.
 */
export class Combatant {
  readonly teamLabel: string
  readonly seat: number
  readonly profile: CombatProfile | null
  readonly currentHealth: number | null

  private constructor(
    key: CombatantKey,
    profile: CombatProfile | null,
    currentHealth: number | null,
  ) {
    this.teamLabel = key.teamLabel
    this.seat = key.seat
    this.profile = profile
    this.currentHealth = currentHealth
  }

  /** Inicia con la Vida completa (`Vida actual = Vida maxima`). */
  static start(key: CombatantKey, profile: CombatProfile | null): Combatant {
    if (profile === null) {
      return Combatant.restore({ ...key, profile: null, currentHealth: null })
    }

    return Combatant.restore({ ...key, profile, currentHealth: profile.maxHealth })
  }

  /** Reconstruye desde persistencia comprobando el invariante de Vida. */
  static restore(snapshot: CombatantSnapshot): Combatant {
    if (!Number.isInteger(snapshot.seat) || snapshot.seat < 0 || snapshot.teamLabel.length === 0) {
      throw new DomainError('La identidad de un combatiente es (teamLabel, seat) con seat >= 0.')
    }

    if (snapshot.profile === null) {
      if (snapshot.currentHealth !== null) {
        throw new DomainError('Un combatiente sin perfil de combate no tiene Vida.')
      }

      return new Combatant(snapshot, null, null)
    }

    const profile = createCombatProfile(snapshot.profile)
    const health = snapshot.currentHealth

    if (health === null || !Number.isInteger(health) || health < 0 || health > profile.maxHealth) {
      throw new DomainError(
        `La Vida de un combatiente debe ser un entero entre 0 y ${String(profile.maxHealth)}.`,
      )
    }

    return new Combatant(snapshot, profile, health)
  }

  get alive(): boolean {
    return this.currentHealth !== null && this.currentHealth > 0
  }

  /** Devuelve otro combatiente con la Vida ya reducida. `appliedDamage` no puede pasar de la Vida actual. */
  withHealth(nextHealth: number): Combatant {
    if (this.profile === null || this.currentHealth === null) {
      throw new DomainError('Un combatiente sin perfil de combate no puede cambiar de Vida.')
    }

    return Combatant.restore({
      teamLabel: this.teamLabel,
      seat: this.seat,
      profile: this.profile,
      currentHealth: nextHealth,
    })
  }

  toSnapshot(): CombatantSnapshot {
    return {
      teamLabel: this.teamLabel,
      seat: this.seat,
      currentHealth: this.currentHealth,
      profile: this.profile,
    }
  }

  toView(): CombatantView {
    return {
      teamLabel: this.teamLabel,
      seat: this.seat,
      health:
        this.profile === null || this.currentHealth === null
          ? null
          : { current: this.currentHealth, max: this.profile.maxHealth },
    }
  }
}
