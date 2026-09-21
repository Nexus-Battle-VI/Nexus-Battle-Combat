import { InvalidCombatProfileError } from '../errors/BattleErrors'

/**
 * Perfil de combate CONGELADO de un participante (HU-18, contrato v1 de
 * Infrastructure): lo minimo que Combat necesita para resolver golpes sin volver
 * a consultar Player-Inventory ni Catalog.
 *
 * Es un modelo LOCAL: espeja los campos que HU-20 lee de `EquippedHero`, pero no
 * importa ningun tipo de otro servicio (ADR-001) y NO copia el inventario, el
 * nombre del heroe, su referencia ni la fecha de seleccion. Se construye una vez
 * al iniciar la batalla (`StartBattle`, con la respuesta que ya se pidio para
 * revalidar HU-16) y no cambia durante ella: cambiar el equipo despues no
 * modifica la batalla.
 */
export type CombatMagnitude =
  | { readonly mode: 'FIXED'; readonly amount: number }
  | { readonly mode: 'PERCENTAGE'; readonly basisPoints: number }
  | { readonly mode: 'DICE'; readonly count: number; readonly sides: number }

/**
 * Efecto de equipamiento tal como lo necesita HU-20 (`prepareAttack` y
 * `buildHeroEffectTable`): el efecto propio que altera la tabla y lo que el equipo
 * del objetivo le resta al atacante. Mismos campos que el contrato de
 * Player-Inventory; los efectos temporales o condicionados se conservan (HU-19
 * los evaluara) pero HU-18 no los aplica.
 */
export interface CombatEffect {
  readonly sourceProductId: string
  readonly sourceProductReference: string
  readonly kind: string
  readonly target: string
  readonly statistic?: string
  readonly operation?: string
  readonly magnitude?: CombatMagnitude
  readonly durationTurns?: number
  readonly hasActivationCondition: boolean
  readonly appliedToStats: boolean
}

export interface CombatProfile {
  readonly heroId: string
  /** Codigo de subtipo (`hero-subtypes-v1`), tal como lo publica Player-Inventory. */
  readonly subtype: string
  readonly maxHealth: number
  /** `null`: el heroe no tiene Ataque numerico (sanadores). */
  readonly attack: number | null
  readonly defense: number
  /** `null`: el heroe no tiene Dano (sanadores). */
  readonly damage: CombatMagnitude | null
  readonly activeEffects: readonly CombatEffect[]
}

const requireNonNegativeInteger = (value: number, field: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidCombatProfileError(
      `El perfil de combate necesita "${field}" como entero no negativo. Se recibio ${String(value)}.`,
    )
  }
}

/**
 * Valida y congela un perfil. Los enteros son los que Player-Inventory garantiza
 * para las estadisticas efectivas; un valor distinto es un dato upstream mal
 * formado y NO se corrige en silencio (nada de `Math.floor` para que pase).
 */
export const createCombatProfile = (profile: CombatProfile): CombatProfile => {
  requireNonNegativeInteger(profile.maxHealth, 'maxHealth')
  requireNonNegativeInteger(profile.defense, 'defense')

  if (profile.attack !== null) {
    requireNonNegativeInteger(profile.attack, 'attack')
  }

  return Object.freeze({
    ...profile,
    damage: profile.damage === null ? null : Object.freeze({ ...profile.damage }),
    activeEffects: Object.freeze(
      profile.activeEffects.map((effect) => Object.freeze({ ...effect })),
    ),
  })
}
