import {
  BattleRoom,
  type BasicAttackReadyPlan,
  type FinishCause,
  type SkillReadyPlan,
} from '../../src/domain/entities/BattleRoom'
import { BattleEventType } from '../../src/domain/entities/BattleEvent'
import type { CombatantKey } from '../../src/domain/entities/Combatant'
import { BattleNotInProgressError } from '../../src/domain/errors/BattleErrors'
import { DomainError } from '../../src/domain/errors/DomainError'
import { NOW, preparingRoom } from '../fixtures/battle'
import { battleWithCombat, combatProfileFixture } from '../fixtures/basic-attack'
import { SHIELD_STRIKE_ID, battleWithSkills } from '../fixtures/skills'

/**
 * Finalizacion de la batalla en el AGREGADO (HU-21, contrato
 * `hu-21-battle-finish-v1` §4, §5 y §7): causas, resultado unico, Poder
 * restaurado (HU-11), liquidacion de vencimientos y fronteras de los
 * temporizadores.
 */
const AT = new Date('2026-09-21T10:05:00.000Z')
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs)

const KEY_A: CombatantKey = { teamLabel: 'A', seat: 0 }
const KEY_B: CombatantKey = { teamLabel: 'B', seat: 0 }

const LETHAL = {
  attackValue: 50,
  defenseValue: 10,
  effective: true,
  effect: 'NORMAL',
  percent: 100,
  baseDamage: 100,
} as const

/** Sala 1v1 con Vida inicial controlada y la cola abierta por A. */
const duel = (health: Readonly<Record<string, number>> = {}): BattleRoom =>
  battleWithCombat({
    health,
    profiles: {
      a1: combatProfileFixture({ maxHealth: 44, maxPower: 10 }),
      b1: combatProfileFixture({ maxHealth: 50, maxPower: 10 }),
    },
  })

/** Cambia el Poder actual de un combatiente persistido (para ver la restauracion de HU-11). */
const withPower = (room: BattleRoom, key: CombatantKey, power: number): BattleRoom => {
  const snapshot = room.toSnapshot()
  const battle = snapshot.battle
  const combatants = battle?.combatants

  if (battle === null || combatants === null || combatants === undefined) {
    throw new Error('La sala de prueba necesita snapshot de combate.')
  }

  return BattleRoom.restore({
    ...snapshot,
    battle: {
      ...battle,
      combatants: combatants.map((combatant) =>
        combatant.teamLabel === key.teamLabel && combatant.seat === key.seat
          ? { ...combatant, currentPower: power }
          : combatant,
      ),
    },
  })
}

/** Sala con la cola retrasada a un instante concreto (para aislar el vencimiento global). */
const withTurnStartedAt = (room: BattleRoom, startedAt: Date): BattleRoom => {
  const snapshot = room.toSnapshot()
  const battle = snapshot.battle

  if (battle === null) {
    throw new Error('La sala de prueba necesita batalla.')
  }

  return BattleRoom.restore({ ...snapshot, battle: { ...battle, turnStartedAt: startedAt } })
}

const lastEvent = (room: BattleRoom, offsetFromEnd = 0) =>
  room.events[room.events.length - 1 - offsetFromEnd]

describe('BattleRoom.finish — matriz condicion -> resultado (contrato §4)', () => {
  it('ELIMINATION: gana el equipo del actor, con `teams` y `participants` coherentes', () => {
    const finished = duel({ 'B#0': 0 }).finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, AT)

    expect(finished.status).toBe('FINISHED')
    expect(finished.result).toEqual({
      reason: 'ELIMINATION',
      outcome: 'WIN',
      winnerTeamLabel: 'A',
      finishedAt: AT.toISOString(),
      tiebreak: null,
      disconnected: null,
      teams: [
        { teamLabel: 'A', remainingHealth: 44, maxHealth: 44, lifePercent: 100, eliminated: false },
        { teamLabel: 'B', remainingHealth: 0, maxHealth: 50, lifePercent: 0, eliminated: true },
      ],
      participants: [
        {
          teamLabel: 'A',
          seat: 0,
          kind: 'HUMAN',
          playerId: 'a1',
          displayName: 'Nombre a1',
          heroId: 'hero-a1',
          result: 'WON',
        },
        {
          teamLabel: 'B',
          seat: 0,
          kind: 'HUMAN',
          playerId: 'b1',
          displayName: 'Nombre b1',
          heroId: 'hero-b1',
          result: 'LOST',
        },
      ],
    })
  })

  it('DISCONNECTION: pierde el equipo del desconectado y gana el rival', () => {
    const finished = duel().finish({ reason: 'DISCONNECTION', disconnected: KEY_A }, AT)

    expect(finished.result?.outcome).toBe('WIN')
    expect(finished.result?.winnerTeamLabel).toBe('B')
    expect(finished.result?.disconnected).toEqual({ teamLabel: 'A', seat: 0 })
    expect(finished.result?.tiebreak).toBeNull()
  })

  it('TIME_LIMIT con porcentajes distintos: gana el mayor porcentaje (LIFE_PERCENT)', () => {
    const finished = duel({ 'A#0': 30, 'B#0': 25 }).finish({ reason: 'TIME_LIMIT' }, AT)

    expect(finished.result).toMatchObject({
      reason: 'TIME_LIMIT',
      outcome: 'WIN',
      winnerTeamLabel: 'A',
      tiebreak: 'LIFE_PERCENT',
    })
  })

  it('TIME_LIMIT con el mismo porcentaje: gana la vida absoluta mayor (ABSOLUTE_LIFE)', () => {
    const finished = duel({ 'A#0': 22, 'B#0': 25 }).finish({ reason: 'TIME_LIMIT' }, AT)

    expect(finished.result).toMatchObject({
      outcome: 'WIN',
      winnerTeamLabel: 'B',
      tiebreak: 'ABSOLUTE_LIFE',
    })
  })

  it('TIME_LIMIT con el mismo porcentaje y la misma vida: NO_WINNER sin desempate', () => {
    const finished = battleWithCombat({ health: { 'A#0': 22, 'B#0': 22 } }).finish(
      { reason: 'TIME_LIMIT' },
      AT,
    )

    expect(finished.result).toMatchObject({
      outcome: 'NO_WINNER',
      winnerTeamLabel: null,
      tiebreak: null,
    })
    expect(finished.result?.participants.map((participant) => participant.result)).toEqual([
      'NO_WINNER',
      'NO_WINNER',
    ])
  })

  it('es idempotente: finalizar de nuevo devuelve la MISMA sala, sin segundo evento', () => {
    const finished = duel({ 'B#0': 0 }).finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, AT)
    const again = finished.finish({ reason: 'TIME_LIMIT' }, new Date(AT.getTime() + 1_000))

    expect(again).toBe(finished)
    expect(again.events.filter((event) => event.type === 'battleFinished')).toHaveLength(1)
  })

  it.each([['WAITING_FOR_PLAYERS' as const], ['PREPARING' as const]])(
    'desde una sala en %s lanza BattleNotInProgressError',
    () => {
      expect(() => preparingRoom().finish({ reason: 'TIME_LIMIT' }, AT)).toThrow(
        BattleNotInProgressError,
      )
    },
  )

  it('publica `battleFinished` con la vista final SIN deadlines y con el Poder restaurado', () => {
    const drained = withPower(duel({ 'B#0': 0 }), KEY_A, 2)
    const finished = drained.finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, AT)
    const event = lastEvent(finished)

    expect(event?.type).toBe(BattleEventType.BattleFinished)
    expect(event?.occurredAt).toEqual(AT)

    const payload = event?.payload as { battle: { deadlines?: unknown } }
    expect(payload.battle.deadlines).toBeUndefined()
    expect(finished.battleView()?.deadlines).toBeUndefined()

    const power = finished
      .battleView()
      ?.combatants.find((combatant) => combatant.teamLabel === 'A' && combatant.seat === 0)?.power
    expect(power).toEqual({ current: 10, max: 10 })

    expect(finished.result?.teams[0]?.remainingHealth).toBe(44)
  })
})

describe('BattleRoom — invariantes de restore (contrato §12)', () => {
  const inBattle = battleWithCombat().toSnapshot()
  const finishedSnapshot = duel({ 'B#0': 0 })
    .finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, AT)
    .toSnapshot()

  it('acepta IN_BATTLE con batalla y FINISHED con batalla y resultado', () => {
    expect(BattleRoom.restore(inBattle).status).toBe('IN_BATTLE')
    expect(BattleRoom.restore(finishedSnapshot).result?.outcome).toBe('WIN')
  })

  it.each([
    ['IN_BATTLE sin batalla', { ...inBattle, battle: null }],
    ['FINISHED sin resultado', { ...inBattle, status: 'FINISHED' as const }],
    ['FINISHED sin batalla', { ...finishedSnapshot, battle: null }],
    [
      'resultado en una sala que no esta FINISHED',
      { ...inBattle, result: finishedSnapshot.result },
    ],
    [
      'resultado en una sala sin batalla',
      { ...preparingRoom().toSnapshot(), result: finishedSnapshot.result },
    ],
  ])('rechaza %s', (_label, snapshot) => {
    expect(() => BattleRoom.restore(snapshot)).toThrow(DomainError)
  })
})

describe('BattleRoom — eliminacion dentro de la accion (contrato §4.1 y §6.2)', () => {
  it('un golpe letal deja la accion y `battleFinished` en la MISMA sala, con `seq` consecutivos', () => {
    const room = duel({ 'B#0': 5 })
    const plan = room.planBasicAttack('a1', 'cmd-1', KEY_B) as BasicAttackReadyPlan
    const next = room.applyBasicAttack(plan, LETHAL, 'cmd-1', AT)
    const action = lastEvent(next, 1)
    const final = lastEvent(next)

    expect(next.status).toBe('FINISHED')
    expect(action?.type).toBe('basicAttackResolved')
    expect(final?.type).toBe('battleFinished')
    expect(final?.seq).toBe((action?.seq ?? 0) + 1)
    expect(next.events).toHaveLength(room.events.length + 2)

    // El evento de la accion NO cambia de forma: sigue trayendo su resolucion y su vista.
    expect(action?.payload).toMatchObject({
      commandId: 'cmd-1',
      attacker: { teamLabel: 'A', seat: 0 },
      target: { teamLabel: 'B', seat: 0 },
      targetHealth: { after: 0 },
    })
    expect(next.result?.reason).toBe('ELIMINATION')
    expect(next.result?.winnerTeamLabel).toBe('A')
    expect(next.hasHandledCommand('cmd-1')).toBe(true)
  })

  it('una habilidad letal tambien finaliza en su misma escritura', () => {
    const room = battleWithSkills({ health: { 'B#0': 5 } })
    const plan = room.planSkill('a1', 'cmd-2', SHIELD_STRIKE_ID, KEY_B) as SkillReadyPlan
    const next = room.applySkill(
      plan,
      { ...LETHAL, attackBonus: 2, damageBonus: null },
      'cmd-2',
      AT,
    )

    expect(next.status).toBe('FINISHED')
    expect(lastEvent(next, 1)?.type).toBe(BattleEventType.SkillUsed)
    expect(lastEvent(next)?.type).toBe(BattleEventType.BattleFinished)
    expect(next.result?.reason).toBe('ELIMINATION')
  })

  it('en 2 contra 2 eliminar a un heroe NO finaliza y su turno se salta', () => {
    const room = battleWithCombat({ teamSizes: [2, 2], health: { 'B#0': 5 } })
    const plan = room.planBasicAttack('a1', 'cmd-3', KEY_B) as BasicAttackReadyPlan
    const next = room.applyBasicAttack(plan, LETHAL, 'cmd-3', AT)

    expect(next.status).toBe('IN_BATTLE')
    expect(next.result).toBeNull()
    // La cola era A0, B0, A1, B1: B0 muere y A1 recibe el turno (B0 saltado).
    expect(next.battle?.turnsCompleted).toBe(2)
    expect(next.battle?.currentEntry).toMatchObject({ teamLabel: 'A', seat: 1 })

    // El segundo golpe letal si finaliza, y el ganador es el equipo del actor.
    const second = next.planBasicAttack('a2', 'cmd-4', { teamLabel: 'B', seat: 1 })
    const finished = next.applyBasicAttack(second as BasicAttackReadyPlan, LETHAL, 'cmd-4', AT)

    expect(finished.status).toBe('FINISHED')
    expect(finished.result?.winnerTeamLabel).toBe('A')
  })
})

describe('BattleRoom.settleDeadlines — liquidacion de vencimientos (contrato §3, §4.4 y §4.5)', () => {
  it('el turno vence a los 30 000 ms exactos (frontera inclusiva) y avanza con 30 s nuevos', () => {
    const room = battleWithCombat()

    expect(room.settleDeadlines(at(29_999), new Map())).toBe(room)

    const settled = room.settleDeadlines(at(30_000), new Map())
    const event = lastEvent(settled)

    expect(event?.type).toBe(BattleEventType.TurnTimedOut)
    expect(event?.payload).toMatchObject({
      completedPosition: 0,
      timedOut: { teamLabel: 'A', seat: 0 },
    })
    expect(settled.battle?.currentEntry).toMatchObject({ teamLabel: 'B', seat: 0 })
    expect(settled.battle?.turnStartedAt).toEqual(at(30_000))

    const view = settled.battleView()
    expect(view?.deadlines?.turnEndsAt).toBe(at(30_000 + 30_000).toISOString())
  })

  it('la gracia vence a los 30 000 ms exactos y finaliza por DISCONNECTION', () => {
    const room = battleWithCombat()
    const absences = new Map([['a1', NOW]])

    expect(room.settleDeadlines(at(29_999), absences)).toBe(room)

    const settled = room.settleDeadlines(at(30_000), absences)

    expect(settled.status).toBe('FINISHED')
    expect(settled.result?.reason).toBe('DISCONNECTION')
    expect(settled.result?.disconnected).toEqual({ teamLabel: 'A', seat: 0 })
    expect(settled.result?.winnerTeamLabel).toBe('B')
  })

  it('el global vence a los 360 000 ms exactos (frontera) con el turno ya renovado', () => {
    const room = withTurnStartedAt(battleWithCombat(), at(330_000))

    expect(room.settleDeadlines(at(359_999), new Map())).toBe(room)

    const settled = room.settleDeadlines(at(360_000), new Map())

    expect(settled.status).toBe('FINISHED')
    expect(settled.result?.reason).toBe('TIME_LIMIT')
  })

  it('una sala que no esta IN_BATTLE no liquida nada (misma instancia)', () => {
    const room = duel({ 'B#0': 0 }).finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, AT)

    expect(room.settleDeadlines(new Date(AT.getTime() + 999_999), new Map())).toBe(room)
  })

  it('en un empate exacto manda DISCONNECTION sobre TIME_LIMIT y sobre el turno', () => {
    const room = withTurnStartedAt(battleWithCombat(), at(330_000))
    const absences = new Map([['a1', at(330_000)]])

    const settled = room.settleDeadlines(at(360_000), absences)

    expect(settled.result?.reason).toBe('DISCONNECTION')
  })

  it('en un empate exacto el global manda sobre el turno', () => {
    const room = withTurnStartedAt(battleWithCombat(), at(330_000))

    const settled = room.settleDeadlines(at(360_000), new Map())

    expect(settled.result?.reason).toBe('TIME_LIMIT')
  })

  it('con varias gracias decide el desconectadoDesde mas antiguo; con el mismo, la posicion menor', () => {
    // El turno se renueva para que no sea el vencimiento mas antiguo: lo que se
    // compara son las dos gracias.
    const room = withTurnStartedAt(battleWithCombat(), at(330_000))
    const both = new Map([
      ['a1', at(10_000)],
      ['b1', at(20_000)],
    ])

    const first = room.settleDeadlines(at(50_000), both)

    expect(first.result?.disconnected).toEqual({ teamLabel: 'A', seat: 0 })

    const same = new Map([
      ['b1', at(10_000)],
      ['a1', at(10_000)],
    ])
    const tie = room.settleDeadlines(at(40_000), same)

    expect(tie.result?.disconnected).toEqual({ teamLabel: 'A', seat: 0 })
  })

  it('una sola transicion por llamada: tras finalizar, repetir es no-op', () => {
    const room = battleWithCombat()
    const absences = new Map([['a1', NOW]])
    const settled = room.settleDeadlines(at(360_000), absences)

    expect(settled.status).toBe('FINISHED')
    expect(settled.settleDeadlines(at(999_999), absences)).toBe(settled)
  })

  it('`turnTimedOut` avanza a alguien CON Vida: el siguiente muerto se salta', () => {
    // Cola A0, B0, A1, B1 con B0 ya eliminado: al vencer el turno de A0, B0 se
    // salta y el turno pasa a A1 (dos posiciones, `turnsCompleted + 2`).
    const room = battleWithCombat({ teamSizes: [2, 2], health: { 'B#0': 0 } })

    const settled = room.settleDeadlines(at(30_000), new Map())

    expect(lastEvent(settled)?.payload).toMatchObject({
      completedPosition: 0,
      timedOut: { teamLabel: 'A', seat: 0 },
    })
    expect(settled.battle?.currentEntry).toMatchObject({ teamLabel: 'A', seat: 1 })
    expect(settled.battle?.turnsCompleted).toBe(2)
  })

  it('no toca `handledCommands` al vencer el turno', () => {
    const room = battleWithCombat()
    const settled = room.settleDeadlines(at(30_000), new Map())

    expect(settled.handledCommands).toBe(room.handledCommands)
  })
})

describe('BattleRoom.nextDueAt — el vencimiento mas inminente', () => {
  it('sin ausencias es el vencimiento del turno', () => {
    const room = battleWithCombat()

    expect(room.nextDueAt(new Map())).toEqual(at(30_000))
  })

  it('incluye la gracia mas temprana de los ausentes', () => {
    const room = withTurnStartedAt(battleWithCombat(), at(330_000))

    expect(room.nextDueAt(new Map([['a1', at(1_000)]]))).toEqual(at(31_000))
  })

  it('fuera de IN_BATTLE no hay vencimiento', () => {
    expect(preparingRoom().nextDueAt(new Map())).toBeNull()
  })
})

describe('BattleRoom.finish — causa final coherente', () => {
  it.each<[string, FinishCause]>([
    ['ELIMINATION', { reason: 'ELIMINATION', winnerTeamLabel: 'A' }],
    ['DISCONNECTION', { reason: 'DISCONNECTION', disconnected: KEY_B }],
    ['TIME_LIMIT', { reason: 'TIME_LIMIT' }],
  ])('acepta la causa %s y guarda una unica finalizacion', (_label, cause) => {
    const finished = battleWithCombat({ health: { 'B#0': 0 } }).finish(cause, AT)

    expect(finished.events.filter((event) => event.type === 'battleFinished')).toHaveLength(1)
    expect(finished.result?.finishedAt).toBe(AT.toISOString())
  })

  it('rechaza una causa con un ganador que no es de la sala', () => {
    expect(() =>
      battleWithCombat().finish({ reason: 'ELIMINATION', winnerTeamLabel: 'C' }, AT),
    ).toThrow(DomainError)
  })
})
