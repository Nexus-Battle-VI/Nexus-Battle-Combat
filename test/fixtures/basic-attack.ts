import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { Combatant } from '../../src/domain/entities/Combatant'
import { createCombatProfile, type CombatProfile } from '../../src/domain/entities/CombatProfile'
import type { TeamRoster, TurnOrderEntry } from '../../src/domain/entities/TurnOrder'
import { ResolveRandomEffect } from '../../src/application/use-cases/ResolveRandomEffect'
import { baseEffectTableFor } from '../../src/domain/random-effects/BaseEffectProfiles'
import type { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { parseHeroSubtype } from '../../src/domain/value-objects/HeroSubtype'
import { NOW, preparingRoom, scriptedSequence, type PreparingRoomOptions } from './battle'

/**
 * Fixtures de HU-18 (ataque basico): salas EN BATALLA con snapshot de combate, y
 * utilidades para construir secuencias HU-24 GUIONIZADAS que producen una cara de
 * dado o un efecto concreto SIN calcular indices a mano.
 */

/** Perfil por defecto: un Guerrero Armas de la Tabla 6 sin equipamiento (Vida 44, Ataque 10 + 1d6, Dano 1d6). */
export const combatProfileFixture = (overrides: Partial<CombatProfile> = {}): CombatProfile =>
  createCombatProfile({
    heroId: 'hero',
    subtype: 'GUERRERO_ARMAS',
    maxHealth: 44,
    attack: 10,
    defense: 11,
    damage: { mode: 'DICE', count: 1, sides: 6 },
    activeEffects: [],
    ...overrides,
  })

export interface BattleWithCombatOptions extends PreparingRoomOptions {
  /** Perfil por `playerId`; `null` = sin perfil (`AI`). Los ausentes usan el perfil por defecto. */
  readonly profiles?: Readonly<Record<string, CombatProfile | null>>
  /** Vida actual por `teamLabel#seat` (por defecto, la maxima). */
  readonly health?: Readonly<Record<string, number>>
  /** Equipo que abre la cola (por defecto A). */
  readonly firstTeam?: 'A' | 'B'
  /** Si es `false` la batalla se inicia SIN snapshot de combate (batalla anterior a HU-18). */
  readonly withCombat?: boolean
}

/** Sala `IN_BATTLE` 1v1 (o la indicada) con snapshot de combate y la cola alternando equipos. */
export const battleWithCombat = (options: BattleWithCombatOptions = {}): BattleRoom => {
  const room = preparingRoom(options)
  const roster = room.roster()
  const first = options.firstTeam === 'B' ? 1 : 0
  const teams: readonly [TeamRoster, TeamRoster] =
    first === 0 ? [roster[0], roster[1]] : [roster[1], roster[0]]
  const order: TurnOrderEntry[] = []
  const longest = Math.max(teams[0].members.length, teams[1].members.length)

  for (let round = 0; round < longest; round += 1) {
    for (const team of teams) {
      const member = team.members[round]

      if (member !== undefined) {
        order.push({ ...member, heroSubtype: member.playerId === null ? null : 'GUERRERO_ARMAS' })
      }
    }
  }

  if (options.withCombat === false) {
    return room.startBattle(order, NOW)
  }

  const combatants = order.map((entry) => {
    const key = `${entry.teamLabel}#${String(entry.seat)}`
    const profile =
      entry.playerId === null
        ? null
        : options.profiles !== undefined && entry.playerId in options.profiles
          ? (options.profiles[entry.playerId] ?? null)
          : combatProfileFixture({ heroId: `hero-${entry.playerId}` })
    const started = Combatant.start(entry, profile)
    const health = options.health?.[key]

    return health === undefined ? started : started.withHealth(health)
  })

  return room.startBattle(order, NOW, combatants)
}

/** Vida actual de un participante de la vista de una sala. */
export const healthOf = (
  room: BattleRoom,
  teamLabel: string,
  seat = 0,
): { current: number; max: number } | null => {
  const entry = room
    .battleView()
    ?.combatants.find((combatant) => combatant.teamLabel === teamLabel && combatant.seat === seat)

  return entry?.health === undefined || entry.health === null
    ? null
    : { current: entry.health.current, max: entry.health.max }
}

/**
 * Menor indice 1..8000 que `dieFaceFromIndex` convierte en `face` para un dado de
 * `sides` caras (`cara = floor((indice - 1) x sides / 8000) + 1`).
 */
export const indexForFace = (face: number, sides: number): number =>
  Math.ceil(((face - 1) * 8000) / sides) + 1

/**
 * Busca el indice que produce el efecto pedido en la tabla BASE del subtipo (y, para
 * el critico, el porcentaje), recorriendo 1..8000 con el resolvedor real de HU-25: no
 * hay indices calculados a mano que puedan quedar desalineados con la tabla.
 */
export const indexForEffect = (
  subtype: string,
  effect: RandomEffectType,
  percent?: number,
): number => {
  const table = baseEffectTableFor(parseHeroSubtype(subtype))
  const resolver = new ResolveRandomEffect()

  for (let index = 1; index <= 8000; index += 1) {
    const resolved = resolver.execute({ sequence: scriptedSequence([index]), table })

    if (resolved.effect === effect && (percent === undefined || resolved.percent === percent)) {
      return index
    }
  }

  throw new Error(
    `Ningun indice produce ${effect}${percent === undefined ? '' : ` ${String(percent)} %`}.`,
  )
}
