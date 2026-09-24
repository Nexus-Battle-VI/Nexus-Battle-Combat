import { DomainError } from '../errors/DomainError'
import { applyHeal } from '../policies/HealApplicationPolicy'
import { regenPower } from '../policies/HeroPowerPolicy'
import { evaluateSkill } from '../policies/SkillEffectPolicy'
import {
  createCombatProfile,
  type CombatAbility,
  type CombatPowerCost,
  type CombatProfile,
} from './CombatProfile'

/** Identidad estable de un participante dentro de la batalla: la misma `memberKey` de HU-17. */
export interface CombatantKey {
  readonly teamLabel: string
  readonly seat: number
}

/**
 * Efecto temporal ACTIVO y ya resuelto (HU-19 v2, contrato §2), persistido dentro del
 * combatiente al que afecta. Distinto de `TemporalEffectTemplate` (`SkillEffectPolicy`): aqui la
 * magnitud ya es un entero (el dado, si lo hubo, se tiro UNA vez al aplicar la habilidad que lo
 * origino) y `remainingOwnTurns` es el contador real que decrementa `closeOwnTurn()`, la MISMA
 * convencion que ya usa la recarga (v1 §5.3): turnos propios del combatiente OBJETIVO (este),
 * no del que lo lanzo.
 */
export type ActiveSkillEffect =
  | {
      readonly sourceAbilityId: string
      readonly sourceCombatant: CombatantKey
      readonly statistic: 'ATTACK' | 'DAMAGE' | 'DEFENSE' | 'HEALING'
      readonly operation: 'INCREASE' | 'DECREASE'
      readonly amount: number
      readonly remainingOwnTurns: number
    }
  | {
      readonly sourceAbilityId: string
      readonly sourceCombatant: CombatantKey
      readonly immunityCode: string
      readonly remainingOwnTurns: number
    }

/**
 * Memoria de 1 turno propio del dano recibido (HU-19 v2, contrato §6): sostiene la condicion
 * generica de `REFLECT_DAMAGE` ("recibio dano en su turno propio anterior"). Se REFRESCA (no se
 * acumula) cada vez que el combatiente recibe dano, y decrementa igual que cualquier efecto
 * temporal al cerrar su turno propio.
 */
export interface DamageMemory {
  readonly amount: number
  readonly remainingOwnTurns: number
}

export interface CombatantSnapshot extends CombatantKey {
  /** `null` cuando el participante no tiene perfil de combate (`AI`). */
  readonly currentHealth: number | null
  readonly profile: CombatProfile | null
  /**
   * HU-19: Poder actual. Ausente o `null` en un combatiente anterior a HU-19 (su perfil
   * no tiene `maxPower`): se restaura sin estado de habilidades, sin rellenar valores.
   */
  readonly currentPower?: number | null
  /** HU-19: turnos propios que le faltan a cada habilidad en recarga. Solo los > 0. */
  readonly cooldowns?: Readonly<Record<string, number>>
  /** HU-19 v2: efectos temporales activos sobre este combatiente (contrato §2). */
  readonly activeSkillEffects?: readonly ActiveSkillEffect[]
  /** HU-19 v2: memoria de dano recibido para `REFLECT_DAMAGE` (contrato §6). */
  readonly damageMemory?: DamageMemory | null
}

/** Vida de un participante tal como la ve un cliente. */
export interface HealthView {
  readonly current: number
  readonly max: number
}

/** Poder de un participante tal como lo ve un cliente (HU-19, `hu-19-skills-v1` §5.4). */
export interface PowerView {
  readonly current: number
  readonly max: number
}

/**
 * Estado de una habilidad para el cliente: lo decide Combat, no la interfaz.
 * `RECHARGING` si le faltan turnos de recarga; `UNSUPPORTED` si algun efecto no esta
 * formalmente soportado; si no, `READY`. El Poder NO cambia el estado: con Poder
 * insuficiente la accion se degrada a ataque basico (HU-11).
 */
export type SkillStatus = 'READY' | 'RECHARGING' | 'UNSUPPORTED'

/**
 * A quien puede dirigirse una habilidad (excepcion de HU-12, sin Task de
 * Management): `OPPONENT` para toda habilidad ofensiva (el default de siempre,
 * HU-19); `ALLY` UNICAMENTE para la excepcion nombrada de curacion (Reanimacion).
 * Nunca lo decide el cliente: lo deriva Combat de `evaluateSkill`, mismo criterio
 * que `status`.
 */
export type SkillTargetAudience = 'OPPONENT' | 'ALLY'

/** Una habilidad tal como la ve un cliente: nunca lleva sus efectos. */
export interface SkillView {
  readonly abilityId: string
  readonly name: string
  readonly powerCost: CombatPowerCost
  readonly chargeTurns: number
  readonly cooldownRemaining: number
  readonly targetAudience: SkillTargetAudience
  readonly status: SkillStatus
}

/** Un participante tal como lo ve un cliente: su Vida, su Poder y sus habilidades, nunca su perfil. */
export interface CombatantView extends CombatantKey {
  /** `null` sin perfil de combate (`AI` o batalla anterior a HU-18). */
  readonly health: HealthView | null
  /** `null` sin perfil o en una batalla anterior a HU-19. */
  readonly power: PowerView | null
  /** `[]` sin perfil o en una batalla anterior a HU-19. */
  readonly skills: readonly SkillView[]
}

const NO_COOLDOWNS: Readonly<Record<string, number>> = Object.freeze({})
const NO_ACTIVE_EFFECTS: readonly ActiveSkillEffect[] = Object.freeze([])

const hasEntries = (record: Readonly<Record<string, number>> | undefined): boolean =>
  record !== undefined && Object.keys(record).length > 0

/** `true` si el efecto es un modificador de estadistica (frente al de inmunidad). */
const isStatEffect = (
  effect: ActiveSkillEffect,
): effect is Extract<ActiveSkillEffect, { statistic: string }> => 'statistic' in effect

/**
 * Estado runtime de UN participante durante la batalla (HU-18, HU-19): su perfil
 * congelado, su Vida actual, su Poder y la recarga de sus habilidades. INMUTABLE:
 * cada cambio devuelve otro `Combatant`.
 *
 * Combat es la fuente de verdad de la Vida, el Poder y la recarga durante la batalla;
 * Player-Inventory conserva la configuracion fuera de ella y no guarda nada de cada
 * golpe.
 *
 * Invariantes: `0 <= currentHealth <= maxHealth`, entero; si el perfil declara
 * `maxPower`, `0 <= currentPower <= maxPower`, entero, y solo puede haber recarga de
 * habilidades del propio perfil (entre 1 y `chargeTurns + 1`). Un participante sin
 * perfil (`AI`: no existe fuente autoritativa de sus estadisticas y no se inventan)
 * tampoco tiene Vida, Poder ni recargas.
 *
 * El Poder es del PARTICIPANTE `(teamLabel, seat)`, nunca del `heroId`: dos jugadores
 * con el mismo heroe no comparten saldo.
 */
export class Combatant {
  readonly teamLabel: string
  readonly seat: number
  readonly profile: CombatProfile | null
  readonly currentHealth: number | null
  /** `null` sin perfil o sin estado de habilidades (batalla anterior a HU-19). */
  readonly currentPower: number | null
  readonly cooldowns: Readonly<Record<string, number>>
  /** HU-19 v2: `[]` sin estado de habilidades. */
  readonly activeSkillEffects: readonly ActiveSkillEffect[]
  /** HU-19 v2: `null` sin memoria vigente o sin estado de habilidades. */
  readonly damageMemory: DamageMemory | null

  private constructor(
    key: CombatantKey,
    profile: CombatProfile | null,
    currentHealth: number | null,
    currentPower: number | null,
    cooldowns: Readonly<Record<string, number>>,
    activeSkillEffects: readonly ActiveSkillEffect[],
    damageMemory: DamageMemory | null,
  ) {
    this.teamLabel = key.teamLabel
    this.seat = key.seat
    this.profile = profile
    this.currentHealth = currentHealth
    this.currentPower = currentPower
    this.cooldowns = cooldowns
    this.activeSkillEffects = activeSkillEffects
    this.damageMemory = damageMemory
  }

  /** Inicia con la Vida y el Poder completos (`actual = maximo`, HU-11) y sin recargas. */
  static start(key: CombatantKey, profile: CombatProfile | null): Combatant {
    if (profile === null) {
      return Combatant.restore({ ...key, profile: null, currentHealth: null })
    }

    return Combatant.restore({
      ...key,
      profile,
      currentHealth: profile.maxHealth,
      currentPower: profile.maxPower ?? null,
    })
  }

  /** Reconstruye desde persistencia comprobando los invariantes de Vida, Poder y recarga. */
  static restore(snapshot: CombatantSnapshot): Combatant {
    if (!Number.isInteger(snapshot.seat) || snapshot.seat < 0 || snapshot.teamLabel.length === 0) {
      throw new DomainError('La identidad de un combatiente es (teamLabel, seat) con seat >= 0.')
    }

    if (snapshot.profile === null) {
      if (snapshot.currentHealth !== null) {
        throw new DomainError('Un combatiente sin perfil de combate no tiene Vida.')
      }

      if (
        (snapshot.currentPower ?? null) !== null ||
        hasEntries(snapshot.cooldowns) ||
        (snapshot.activeSkillEffects?.length ?? 0) > 0 ||
        (snapshot.damageMemory ?? null) !== null
      ) {
        throw new DomainError(
          'Un combatiente sin perfil de combate no tiene Poder, recargas ni efectos temporales.',
        )
      }

      return new Combatant(snapshot, null, null, null, NO_COOLDOWNS, NO_ACTIVE_EFFECTS, null)
    }

    const profile = createCombatProfile(snapshot.profile)
    const health = snapshot.currentHealth

    if (health === null || !Number.isInteger(health) || health < 0 || health > profile.maxHealth) {
      throw new DomainError(
        `La Vida de un combatiente debe ser un entero entre 0 y ${String(profile.maxHealth)}.`,
      )
    }

    return new Combatant(
      snapshot,
      profile,
      health,
      Combatant.restorePower(profile, snapshot.currentPower ?? null),
      Combatant.restoreCooldowns(profile, snapshot.cooldowns),
      Combatant.restoreActiveSkillEffects(profile, snapshot.activeSkillEffects),
      Combatant.restoreDamageMemory(profile, snapshot.damageMemory ?? null),
    )
  }

  private static restorePower(profile: CombatProfile, power: number | null): number | null {
    if (profile.maxPower === undefined) {
      if (power !== null) {
        throw new DomainError('Un combatiente anterior a HU-19 no tiene Poder de batalla.')
      }

      return null
    }

    if (power === null || !Number.isInteger(power) || power < 0 || power > profile.maxPower) {
      throw new DomainError(
        `El Poder de un combatiente debe ser un entero entre 0 y ${String(profile.maxPower)}.`,
      )
    }

    return power
  }

  private static restoreCooldowns(
    profile: CombatProfile,
    cooldowns: Readonly<Record<string, number>> | undefined,
  ): Readonly<Record<string, number>> {
    if (!hasEntries(cooldowns) || cooldowns === undefined) {
      return NO_COOLDOWNS
    }

    if (profile.maxPower === undefined) {
      throw new DomainError('Un combatiente anterior a HU-19 no tiene recargas.')
    }

    const restored: Record<string, number> = {}

    for (const [abilityId, remaining] of Object.entries(cooldowns)) {
      const ability = profile.abilities?.find((candidate) => candidate.abilityId === abilityId)

      if (ability === undefined) {
        throw new DomainError('Una recarga pertenece a una habilidad que el heroe no tiene.')
      }

      // `chargeTurns + 1` es el valor transitorio con el que `applySkill` marca la recarga
      // antes de cerrar el turno propio; una batalla persistida siempre trae <= chargeTurns.
      if (!Number.isInteger(remaining) || remaining < 1 || remaining > ability.chargeTurns + 1) {
        throw new DomainError(
          `La recarga de una habilidad debe ser un entero entre 1 y ${String(ability.chargeTurns + 1)}.`,
        )
      }

      restored[abilityId] = remaining
    }

    return Object.freeze(restored)
  }

  /**
   * Reconstruye los efectos temporales activos (HU-19 v2, contrato §2), comprobando los mismos
   * invariantes de forma que la recarga: solo con estado de habilidades, `remainingOwnTurns`
   * entero >= 1, y una magnitud (`amount`) entera para los efectos de estadistica.
   */
  private static restoreActiveSkillEffects(
    profile: CombatProfile,
    effects: readonly ActiveSkillEffect[] | undefined,
  ): readonly ActiveSkillEffect[] {
    if (effects === undefined || effects.length === 0) {
      return NO_ACTIVE_EFFECTS
    }

    if (profile.maxPower === undefined) {
      throw new DomainError('Un combatiente anterior a HU-19 no tiene efectos temporales.')
    }

    for (const effect of effects) {
      if (!Number.isInteger(effect.remainingOwnTurns) || effect.remainingOwnTurns < 1) {
        throw new DomainError('Un efecto temporal debe tener remainingOwnTurns entero >= 1.')
      }

      if (isStatEffect(effect) && !Number.isInteger(effect.amount)) {
        throw new DomainError('La magnitud de un efecto temporal debe ser un entero.')
      }

      if (!isStatEffect(effect) && effect.immunityCode.trim().length === 0) {
        throw new DomainError('Un efecto de inmunidad debe traer su codigo.')
      }
    }

    return Object.freeze(effects.map((effect) => Object.freeze({ ...effect })))
  }

  /** Misma comprobacion de forma que un efecto temporal, para la memoria de dano de `REFLECT_DAMAGE`. */
  private static restoreDamageMemory(
    profile: CombatProfile,
    memory: DamageMemory | null,
  ): DamageMemory | null {
    if (memory === null) {
      return null
    }

    if (profile.maxPower === undefined) {
      throw new DomainError('Un combatiente anterior a HU-19 no tiene memoria de dano.')
    }

    if (!Number.isInteger(memory.amount) || memory.amount < 0) {
      throw new DomainError('La memoria de dano debe ser un entero no negativo.')
    }

    if (!Number.isInteger(memory.remainingOwnTurns) || memory.remainingOwnTurns < 1) {
      throw new DomainError('La memoria de dano debe tener remainingOwnTurns entero >= 1.')
    }

    return { ...memory }
  }

  get alive(): boolean {
    return this.currentHealth !== null && this.currentHealth > 0
  }

  /** `true` si el combatiente tiene Poder y habilidades congelados (batalla iniciada con HU-19). */
  get hasSkillState(): boolean {
    return this.currentPower !== null && this.profile?.abilities !== undefined
  }

  get abilities(): readonly CombatAbility[] {
    return this.profile?.abilities ?? []
  }

  /** Turnos propios que le faltan a la habilidad; `0` si esta disponible. */
  cooldownOf(abilityId: string): number {
    return this.cooldowns[abilityId] ?? 0
  }

  /**
   * HU-19 v2 (contrato §2): el ajuste NETO (suma de incrementos menos decrementos) que los
   * efectos temporales ACTIVOS de este combatiente aportan a `statistic`, para que cada
   * resolucion futura que la consulte (Ataque/Defensa/Dano, basica o de habilidad) la lea sin
   * reescribir el valor base -- mismo criterio que ya aplican los modificadores de equipo.
   */
  statBonus(statistic: 'ATTACK' | 'DAMAGE' | 'DEFENSE'): number {
    let total = 0

    for (const effect of this.activeSkillEffects) {
      if (isStatEffect(effect) && effect.statistic === statistic) {
        total += effect.operation === 'INCREASE' ? effect.amount : -effect.amount
      }
    }

    return total
  }

  /** Otro combatiente con estos efectos temporales AGREGADOS a los ya activos. */
  withAddedActiveSkillEffects(effects: readonly ActiveSkillEffect[]): Combatant {
    if (effects.length === 0) {
      return this
    }

    if (this.currentPower === null) {
      throw new DomainError('Un combatiente sin estado de habilidades no tiene efectos temporales.')
    }

    return Combatant.restore({
      ...this.toSnapshot(),
      activeSkillEffects: [...this.activeSkillEffects, ...effects],
    })
  }

  /**
   * Refresca la memoria de dano recibido (HU-19 v2, contrato §6): NO se acumula, se
   * SOBRESCRIBE con el ultimo golpe y su ventana de 1 turno propio. Sin estado de habilidades
   * (batalla anterior a HU-19) o sin dano real (`amount <= 0`) no hay nada que recordar.
   */
  withDamageTaken(amount: number): Combatant {
    if (amount <= 0 || this.currentPower === null) {
      return this
    }

    return Combatant.restore({
      ...this.toSnapshot(),
      damageMemory: { amount, remainingOwnTurns: 1 },
    })
  }

  /** Devuelve otro combatiente con la Vida ya reducida. `appliedDamage` no puede pasar de la Vida actual. */
  withHealth(nextHealth: number): Combatant {
    if (this.profile === null || this.currentHealth === null) {
      throw new DomainError('Un combatiente sin perfil de combate no puede cambiar de Vida.')
    }

    return Combatant.restore({ ...this.toSnapshot(), currentHealth: nextHealth })
  }

  /** Otro combatiente con el Poder indicado (entre 0 y el maximo). */
  withPower(nextPower: number): Combatant {
    if (this.currentPower === null) {
      throw new DomainError('Un combatiente sin estado de habilidades no tiene Poder que cambiar.')
    }

    return Combatant.restore({ ...this.toSnapshot(), currentPower: nextPower })
  }

  /** Otro combatiente con la habilidad marcada en recarga (`remaining` turnos propios). */
  withCooldown(abilityId: string, remaining: number): Combatant {
    if (this.currentPower === null) {
      throw new DomainError('Un combatiente sin estado de habilidades no tiene recargas.')
    }

    return Combatant.restore({
      ...this.toSnapshot(),
      cooldowns: { ...this.cooldowns, [abilityId]: remaining },
    })
  }

  /**
   * Comienza el turno propio (HU-11, RF-11): regenera exactamente +2 de Poder sin superar
   * el maximo. Sin estado de habilidades no hay nada que regenerar.
   */
  openOwnTurn(): Combatant {
    if (
      this.profile === null ||
      this.currentPower === null ||
      this.profile.maxPower === undefined
    ) {
      return this
    }

    const regenerated = regenPower({
      heroId: `${this.teamLabel}:${String(this.seat)}`,
      current: this.currentPower,
      max: this.profile.maxPower,
    })

    return regenerated.current === this.currentPower ? this : this.withPower(regenerated.current)
  }

  /**
   * Cierra el turno propio (`hu-19-skills-v1` §5.3, ampliado por `hu-19-skills-v2` §2): a cada
   * habilidad en recarga le falta un turno propio menos, y a cada efecto temporal ACTIVO de
   * este combatiente (y a su memoria de dano de `REFLECT_DAMAGE`) tambien -- MISMA convencion,
   * un solo decremento por cierre. El que llega a 0 vuelve a estar disponible/expira y deja de
   * guardarse; no se reaplica al expirar (contrato §2), simplemente deja de sumar.
   *
   * Un efecto temporal `HEALING` ademas APLICA su tick de sanacion (acotado al maximo de Vida,
   * `HealApplicationPolicy`) mientras siga activo -- es la UNICA forma en que cerrar el turno
   * propio cambia la Vida; sin efectos de sanacion activos no toca ni el Poder ni la Vida
   * (comportamiento previo, sin cambios).
   */
  closeOwnTurn(): Combatant {
    const hasCooldowns = hasEntries(this.cooldowns)
    const hasActiveEffects = this.activeSkillEffects.length > 0
    const hasDamageMemory = this.damageMemory !== null

    if (!hasCooldowns && !hasActiveEffects && !hasDamageMemory) {
      return this
    }

    const ticked: Record<string, number> = {}

    for (const [abilityId, remaining] of Object.entries(this.cooldowns)) {
      if (remaining > 1) {
        ticked[abilityId] = remaining - 1
      }
    }

    let health = this.currentHealth
    const survivingEffects: ActiveSkillEffect[] = []

    for (const effect of this.activeSkillEffects) {
      if (
        isStatEffect(effect) &&
        effect.statistic === 'HEALING' &&
        effect.operation === 'INCREASE' &&
        health !== null &&
        this.profile !== null
      ) {
        health = applyHeal(health, this.profile.maxHealth, effect.amount).healthAfter
      }

      const remainingOwnTurns = effect.remainingOwnTurns - 1

      if (remainingOwnTurns > 0) {
        survivingEffects.push({ ...effect, remainingOwnTurns })
      }
    }

    const nextDamageMemory =
      this.damageMemory === null
        ? null
        : this.damageMemory.remainingOwnTurns - 1 > 0
          ? { ...this.damageMemory, remainingOwnTurns: this.damageMemory.remainingOwnTurns - 1 }
          : null

    return Combatant.restore({
      ...this.toSnapshot(),
      currentHealth: health,
      cooldowns: ticked,
      activeSkillEffects: survivingEffects,
      damageMemory: nextDamageMemory,
    })
  }

  toSnapshot(): CombatantSnapshot {
    return {
      teamLabel: this.teamLabel,
      seat: this.seat,
      currentHealth: this.currentHealth,
      profile: this.profile,
      // Solo se escribe cuando existe: un combatiente anterior a HU-19 no se rellena.
      ...(this.currentPower === null
        ? {}
        : {
            currentPower: this.currentPower,
            cooldowns: { ...this.cooldowns },
            activeSkillEffects: this.activeSkillEffects.map((effect) => ({ ...effect })),
            damageMemory: this.damageMemory === null ? null : { ...this.damageMemory },
          }),
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
      power:
        this.profile?.maxPower === undefined || this.currentPower === null
          ? null
          : { current: this.currentPower, max: this.profile.maxPower },
      skills: this.abilities.map((ability): SkillView => {
        const cooldownRemaining = this.cooldownOf(ability.abilityId)
        const support = evaluateSkill(ability)

        return {
          abilityId: ability.abilityId,
          name: ability.name,
          powerCost: ability.powerCost,
          chargeTurns: ability.chargeTurns,
          cooldownRemaining,
          targetAudience: support.supported && support.kind === 'HEAL' ? 'ALLY' : 'OPPONENT',
          status: !support.supported
            ? 'UNSUPPORTED'
            : cooldownRemaining > 0
              ? 'RECHARGING'
              : 'READY',
        }
      }),
    }
  }
}
