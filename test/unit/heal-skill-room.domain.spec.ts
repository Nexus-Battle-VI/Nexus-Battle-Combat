import type { BattleRoom, SkillHealReadyPlan } from '../../src/domain/entities/BattleRoom'
import { BattleEventType, type HealSkillUsedPayload } from '../../src/domain/entities/BattleEvent'
import {
  ActorUnavailableError,
  InsufficientPowerForHealError,
  InvalidHealTargetError,
  InvalidTargetError,
  SameTeamTargetError,
} from '../../src/domain/errors/BattleErrors'
import { NOW } from '../fixtures/battle'
import { battleWithCombat, healthOf } from '../fixtures/basic-attack'
import { REANIMATE, REANIMATE_ID, SHIELD_STRIKE_ID, skillProfile } from '../fixtures/skills'

/**
 * Excepcion de curacion de HU-12 (Tabla 7, sin Task de Management): Reanimacion
 * (Medico) es la UNICA habilidad que puede dirigirse a un aliado. Sala 2v2
 * (`a1`/`a2` vs `b1`/`b2`) para tener un companero de verdad distinto de uno
 * mismo y de un rival. `a1` (asiento 0) es SIEMPRE quien abre la cola de turnos
 * (`battleWithCombat`, ronda 0 = asiento 0 de cada equipo): el Medico es `a1`
 * para poder actuar en el primer turno sin tener que avanzar la batalla primero.
 */
const LATER = new Date(NOW.getTime() + 5_000)

/** `a1` es el Medico (Reanimacion, sin Ataque numerico -- Tabla 6); `a2`/`b1`/`b2` son ofensivos por defecto. */
const healerRoom = (overrides: Parameters<typeof battleWithCombat>[0] = {}): BattleRoom =>
  battleWithCombat({
    teamSizes: [2, 2],
    profiles: {
      a1: skillProfile({ attack: null, damage: null, abilities: [REANIMATE] }),
    },
    ...overrides,
  })

const healPlan = (
  room: BattleRoom,
  target: { teamLabel: string; seat: number },
): SkillHealReadyPlan => {
  const plan = room.planSkill('a1', 'cmd-heal', REANIMATE_ID, target)

  if (plan.kind !== 'healSkill') {
    throw new Error(`se esperaba un plan de curacion y llego ${plan.kind}`)
  }

  return plan
}

describe('BattleRoom.planSkill — Reanimacion exige un aliado (excepcion de HU-12)', () => {
  it('sobre un rival: InvalidHealTargetError (no SameTeamTargetError: la audiencia es al reves)', () => {
    const room = healerRoom()

    expect(() => room.planSkill('a1', 'cmd-1', REANIMATE_ID, { teamLabel: 'B', seat: 0 })).toThrow(
      InvalidHealTargetError,
    )
  })

  it('sobre uno mismo: InvalidHealTargetError ("el companero" excluye a quien la usa)', () => {
    const room = healerRoom()

    expect(() => room.planSkill('a1', 'cmd-1', REANIMATE_ID, { teamLabel: 'A', seat: 0 })).toThrow(
      InvalidHealTargetError,
    )
  })

  it('sobre un aliado CAIDO (Vida 0): ACEPTADO -- el uso central de "reanimar"', () => {
    const room = healerRoom({ health: { 'A#1': 0 } })
    const plan = healPlan(room, { teamLabel: 'A', seat: 1 })

    expect(plan.targetHealth).toBe(0)
    expect(plan.healMagnitude).toEqual({ mode: 'PERCENTAGE', basisPoints: 10_000 })
  })

  it('sobre un aliado VIVO pero herido: TAMBIEN aceptado -- la Tabla 7 no lo restringe a un caido', () => {
    const room = healerRoom({ health: { 'A#1': 10 } })
    const plan = healPlan(room, { teamLabel: 'A', seat: 1 })

    expect(plan.targetHealth).toBe(10)
  })

  it('una habilidad OFENSIVA sigue exigiendo un rival: el companero sigue bloqueado (sin regresion de HU-12)', () => {
    const room = battleWithCombat({ teamSizes: [2, 2], profiles: { a1: skillProfile() } })

    expect(() =>
      room.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, { teamLabel: 'A', seat: 1 }),
    ).toThrow(SameTeamTargetError)
  })

  it('el ataque basico sigue exigiendo un rival, sin excepcion (regresion HU-12/HU-18)', () => {
    const room = battleWithCombat({ teamSizes: [2, 2] })

    expect(() => room.planBasicAttack('a1', 'cmd-1', { teamLabel: 'A', seat: 1 })).toThrow(
      SameTeamTargetError,
    )
  })

  it('un objetivo que no existe en la batalla: InvalidTargetError, antes de mirar la audiencia', () => {
    const room = healerRoom()

    expect(() => room.planSkill('a1', 'cmd-1', REANIMATE_ID, { teamLabel: 'A', seat: 9 })).toThrow(
      InvalidTargetError,
    )
  })

  it('Poder insuficiente en Reanimacion: rechazo directo, NUNCA se degrada a ataque basico (el sanador no tiene Ataque)', () => {
    const room = healerRoom({
      health: { 'A#1': 0 },
      profiles: {
        a1: skillProfile({ maxPower: 0, attack: null, damage: null, abilities: [REANIMATE] }),
      },
    })

    expect(() => room.planSkill('a1', 'cmd-1', REANIMATE_ID, { teamLabel: 'A', seat: 1 })).toThrow(
      InsufficientPowerForHealError,
    )
  })

  it('el propio sanador caido no puede actuar (ActorUnavailableError, sin excepcion)', () => {
    const room = healerRoom({ health: { 'A#0': 0 } })

    expect(() => room.planSkill('a1', 'cmd-1', REANIMATE_ID, { teamLabel: 'A', seat: 1 })).toThrow(
      ActorUnavailableError,
    )
  })
})

describe('BattleRoom.applyHealSkill — UNA sola transicion atomica, DETERMINISTA', () => {
  it('un aliado caido (Vida 0) queda en su Vida MAXIMA, Poder del actor a 0 (ALL_AVAILABLE) y turno avanzado', () => {
    const room = healerRoom({ health: { 'A#1': 0 } })
    const plan = healPlan(room, { teamLabel: 'A', seat: 1 })
    const after = room.applyHealSkill(plan, 'cmd-1', LATER)

    expect(healthOf(after, 'A', 1)).toEqual({ current: 44, max: 44 })
    expect(
      after.battle?.combatants?.find((c) => c.teamLabel === 'A' && c.seat === 0)?.currentPower,
    ).toBe(0)
    expect(after.battle?.turnsCompleted).toBe(1)
    expect(after.battleView()?.currentTurn.playerId).toBe('b1')
  })

  it('un aliado herido (no caido) sube a su maximo, nunca por encima (sin overheal)', () => {
    const room = healerRoom({ health: { 'A#1': 30 } })
    const plan = healPlan(room, { teamLabel: 'A', seat: 1 })
    const after = room.applyHealSkill(plan, 'cmd-1', LATER)

    expect(healthOf(after, 'A', 1)).toEqual({ current: 44, max: 44 })
  })

  it('el evento es healSkillUsed, con el monto sanado y la Vida antes/despues; SIN resolution ni bonus (no es un golpe)', () => {
    const room = healerRoom({ health: { 'A#1': 12 } })
    const plan = healPlan(room, { teamLabel: 'A', seat: 1 })
    const after = room.applyHealSkill(plan, 'cmd-1', LATER)
    const event = after.events.at(-1)

    expect(event?.type).toBe(BattleEventType.HealSkillUsed)

    const payload = event?.payload as HealSkillUsedPayload

    expect(payload.heal).toEqual({ amount: 32 })
    expect(payload.targetHealth).toEqual({ before: 12, after: 44 })
    expect(payload.actor).toEqual({ teamLabel: 'A', seat: 0 })
    expect(payload.target).toEqual({ teamLabel: 'A', seat: 1 })
    expect(payload.skill.abilityId).toBe(REANIMATE_ID)
    expect(payload).not.toHaveProperty('resolution')
    expect(payload).not.toHaveProperty('bonus')
  })

  it('la habilidad queda en recarga: chargeTurns tras cerrarse el turno propio en la misma transicion', () => {
    const room = healerRoom({ health: { 'A#1': 0 } })
    const plan = healPlan(room, { teamLabel: 'A', seat: 1 })
    const after = room.applyHealSkill(plan, 'cmd-1', LATER)

    // `applyHealSkill` marca chargeTurns + 1 y `completeTurn` cierra el turno
    // propio del actor en la MISMA transicion (mismo criterio que `applySkill`):
    // tras la accion queda exactamente `chargeTurns`, no `chargeTurns + 1`.
    expect(
      after.battle?.combatants
        ?.find((c) => c.teamLabel === 'A' && c.seat === 0)
        ?.cooldownOf(REANIMATE_ID),
    ).toBe(REANIMATE.chargeTurns)
  })

  it('commandId repetido: el plan es un replay, no se vuelve a curar', () => {
    const room = healerRoom({ health: { 'A#1': 0 } })
    const plan = healPlan(room, { teamLabel: 'A', seat: 1 })
    const after = room.applyHealSkill(plan, 'cmd-1', LATER)
    const replay = after.planSkill('a1', 'cmd-1', REANIMATE_ID, { teamLabel: 'A', seat: 1 })

    expect(replay.kind).toBe('replay')
  })

  it('curar nunca puede eliminar a nadie: la batalla sigue IN_BATTLE', () => {
    const room = healerRoom({ health: { 'A#1': 0 } })
    const plan = healPlan(room, { teamLabel: 'A', seat: 1 })
    const after = room.applyHealSkill(plan, 'cmd-1', LATER)

    expect(after.status).toBe('IN_BATTLE')
  })

  it('la sala original NO se toca (inmutabilidad)', () => {
    const room = healerRoom({ health: { 'A#1': 0 } })
    const plan = healPlan(room, { teamLabel: 'A', seat: 1 })

    room.applyHealSkill(plan, 'cmd-1', LATER)

    expect(healthOf(room, 'A', 1)).toEqual({ current: 0, max: 44 })
  })
})
