import { HeroSubtype } from '../value-objects/HeroSubtype'

/**
 * Elegibilidad precombate del heroe equipado de un jugador para UNA sala
 * concreta (HU-16, RF-16, Management#25/#401/#402).
 *
 * AUTORIDAD: esta politica es de COMBAT, no de Player-Inventory. Decide dos
 * cosas que solo Combat puede saber, porque dependen de la sala:
 *
 *  1. Si el heroe preparado del jugador (`ready`/`blockers`, ya calculados
 *     por `HeroReadinessPolicy` de Player-Inventory) puede usarse tal cual.
 *     ESTA POLITICA NO REEVALUA equipamiento, capacidades 2/6/2 ni
 *     propiedad de producto -- eso ya lo decidio Player-Inventory, y
 *     repetirlo aqui seria la segunda implementacion que la auditoria
 *     HU-16.1 (DP-1) prohibe expresamente. Los `blockers` se REENVIAN
 *     TAL CUAL.
 *  2. Si el SUBTIPO del heroe puede participar en el FORMATO de la sala
 *     concreta (DP-5: Chaman y Medico no en 1 contra 1). El formato no es
 *     un campo de dominio propio (HU-16.1, DP-5): se deriva de la
 *     capacidad de los dos equipos de la sala, EXACTAMENTE como ya hace
 *     `BattleMode` con la modalidad (sin inventar un enum nuevo).
 *
 * `heroSubtype` viaja como `string`, NO como `HeroSubtype` parseado: igual
 * que `PlayerInventoryHttpClient` (ver su comentario), validar el
 * vocabulario aqui rechazaria la union a sala de un heroe con un subtipo
 * nuevo que HU-25 todavia no conoce, cuando esta regla concreta solo
 * necesita comparar contra DOS codigos conocidos. Un subtipo desconocido
 * simplemente no esta en la lista restringida (falla abierto en ESTA
 * comprobacion puntual, no en la elegibilidad completa).
 *
 * GAPS DELIBERADAMENTE NO CUBIERTOS (HU-16.1, DP-2/DP-3/DP-4): nivel del
 * heroe, nivel minimo de sala y mision activa. Ninguno de los tres tiene
 * hoy una fuente autoritativa real en ningun servicio (ver
 * `docs/hu-16-precombat-eligibility.md`). Esta politica NO LOS EVALUA:
 * inventar `level = 1` o `missionActive = false` para aparentar
 * cumplimiento esta expresamente prohibido por la TASK HU-16.2.
 */

/** Motivo de bloqueo de elegibilidad. Misma forma que `EquippedHeroBlocker`. */
export interface PrecombatEligibilityBlocker {
  readonly code: string
  /** Ranura afectada, o `null` cuando el impedimento no es de una ranura. */
  readonly slot: string | null
  readonly reference: string
  readonly detail: string
}

export interface PrecombatEligibility {
  readonly eligible: boolean
  readonly blockers: readonly PrecombatEligibilityBlocker[]
}

/** Par de equipos de una sala, reducido a lo unico que esta politica necesita. */
export interface EligibilityTeamCapacity {
  readonly capacity: number
}

/**
 * Codigo reservado para cuando `ready=false` sin ningun `blockers` (defensa
 * en profundidad): un contrato real de Player-Inventory con `ready=false`
 * SIEMPRE declara al menos un motivo (`HeroReadinessPolicy` no lo permite
 * de otra forma), pero esta politica no debe interpretar la AUSENCIA de un
 * motivo como "sin motivo, entonces elegible" -- eso seria exactamente
 * "reinterpretar `ready=false` como exito", que la TASK HU-16.2 prohibe.
 */
export const HERO_NOT_READY_WITHOUT_DETAIL = 'HERO_NOT_READY'

/**
 * Codigo cuando el subtipo del heroe no puede participar en el formato
 * derivado de la sala (DP-5).
 */
export const HERO_CLASS_NOT_ALLOWED_FOR_FORMAT = 'HERO_CLASS_NOT_ALLOWED_FOR_FORMAT'

/**
 * Subtipos que RF-16 restringe a modalidades de equipo (DP-5). Comparacion
 * por TEXTO, no por `HeroSubtype` parseado -- ver el comentario de arriba.
 */
const RESTRICTED_TO_TEAM_FORMATS: readonly string[] = [HeroSubtype.Chaman, HeroSubtype.Medico]

/**
 * Deriva si una sala equivale a un enfrentamiento 1 contra 1 (DP-5).
 *
 * NO EXISTE UN CAMPO `format` (HU-16.1, DP-5): se deriva de la capacidad de
 * los dos equipos, la MISMA fuente que ya usa `BattleRoom.totalCapacity()`.
 * "1 contra 1" es EXACTAMENTE un participante por bando: dos equipos de
 * capacidad 1. Una sala 2v2 o 3v3 (o composiciones desiguales, si algun dia
 * se permiten) no lo es.
 */
export const isIndividualFormat = (
  teams: readonly [EligibilityTeamCapacity, EligibilityTeamCapacity],
): boolean => teams[0].capacity === 1 && teams[1].capacity === 1

export interface AssessPrecombatEligibilityInput {
  /** Subtipo del heroe equipado, tal como lo publica Player-Inventory (texto crudo). */
  readonly heroSubtype: string
  /** Resultado de `isIndividualFormat()` sobre los equipos de la sala destino. */
  readonly individualFormat: boolean
  /** `EquippedHero.ready` (Player-Inventory, `HeroReadinessPolicy`). */
  readonly heroReady: boolean
  /** `EquippedHero.blockers` (Player-Inventory). Se reenvian tal cual cuando `heroReady` es `false`. */
  readonly heroBlockers: readonly PrecombatEligibilityBlocker[]
}

/**
 * Evalua la elegibilidad precombate de un heroe para una sala concreta.
 *
 * Pura: sin I/O, sin dependencias de infraestructura. `JoinBattleRoom`
 * (aplicacion) es quien resuelve `individualFormat` a partir de la sala y
 * `heroSubtype`/`heroReady`/`heroBlockers` a partir del contrato de
 * Player-Inventory, y quien traduce un resultado no elegible a
 * `PrecombatEligibilityBlockedError` (422).
 */
export const assessPrecombatEligibility = (
  input: AssessPrecombatEligibilityInput,
): PrecombatEligibility => {
  const blockers: PrecombatEligibilityBlocker[] = []

  if (!input.heroReady) {
    if (input.heroBlockers.length > 0) {
      blockers.push(...input.heroBlockers)
    } else {
      blockers.push({
        code: HERO_NOT_READY_WITHOUT_DETAIL,
        slot: null,
        reference: input.heroSubtype,
        detail:
          'El heroe preparado no esta listo para combate (Player-Inventory no declaro un motivo especifico).',
      })
    }
  }

  if (input.individualFormat && RESTRICTED_TO_TEAM_FORMATS.includes(input.heroSubtype)) {
    blockers.push({
      code: HERO_CLASS_NOT_ALLOWED_FOR_FORMAT,
      slot: null,
      reference: input.heroSubtype,
      detail: `El subtipo de heroe "${input.heroSubtype}" solo puede participar en modalidades de equipo, no en un enfrentamiento 1 contra 1.`,
    })
  }

  return { eligible: blockers.length === 0, blockers }
}
