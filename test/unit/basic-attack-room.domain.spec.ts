import {
  BattleRoom,
  type BasicAttackOutcome,
  type BasicAttackReadyPlan,
} from '../../src/domain/entities/BattleRoom'
import { BattleState } from '../../src/domain/entities/BattleState'
import { Combatant } from '../../src/domain/entities/Combatant'
import { createCombatProfile } from '../../src/domain/entities/CombatProfile'
import { BattleEventType } from '../../src/domain/entities/BattleEvent'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  InvalidBattleRosterError,
  InvalidCombatProfileError,
  InvalidCommandIdError,
  InvalidTargetError,
  NotYourTurnError,
  SameTeamTargetError,
  TargetUnavailableError,
  UnsupportedCombatProfileError,
} from '../../src/domain/errors/BattleErrors'
import { DomainError } from '../../src/domain/errors/DomainError'
import { NOW, ROOM_ID, preparingRoom } from '../fixtures/battle'
import { battleWithCombat, combatProfileFixture, healthOf } from '../fixtures/basic-attack'

/**
 * Ataque basico en el AGREGADO (HU-18): validacion previa SIN aleatoriedad y una
 * unica transicion atomica (Vida + evento + commandId + turno).
 */
const TARGET = { teamLabel: 'B', seat: 0 }
const LATER = new Date(NOW.getTime() + 5_000)

const ready = (
  plan: ReturnType<ReturnType<typeof battleWithCombat>['planBasicAttack']>,
): BasicAttackReadyPlan => {
  if (plan.kind !== 'ready') {
    throw new Error('se esperaba un plan listo')
  }

  return plan
}

const hit = (overrides: Partial<BasicAttackOutcome> = {}): BasicAttackOutcome => ({
  attackValue: 14,
  defenseValue: 11,
  effective: true,
  effect: 'DAMAGE',
  percent: 100,
  baseDamage: 5,
  ...overrides,
})

const MISS: BasicAttackOutcome = {
  attackValue: 11,
  defenseValue: 11,
  effective: false,
  effect: null,
  percent: null,
  baseDamage: null,
}

describe('BattleRoom.planBasicAttack — validacion previa (0 sorteos)', () => {
  it('un ataque valido: el atacante es quien tiene el turno y el objetivo es del otro equipo', () => {
    const plan = ready(battleWithCombat().planBasicAttack('a1', 'cmd-1', TARGET))

    expect(plan.attackerEntry).toMatchObject({ teamLabel: 'A', seat: 0, playerId: 'a1' })
    expect(plan.targetEntry).toMatchObject({ teamLabel: 'B', seat: 0, playerId: 'b1' })
    expect(plan.targetHealth).toBe(44)
    expect(plan.damage).toEqual({ mode: 'DICE', count: 1, sides: 6 })
  })

  it('planificar NO muta la sala', () => {
    const room = battleWithCombat()
    const before = JSON.stringify(room.toSnapshot())

    room.planBasicAttack('a1', 'cmd-1', TARGET)

    expect(JSON.stringify(room.toSnapshot())).toBe(before)
  })

  it('fuera de turno: NotYourTurnError', () => {
    expect(() =>
      battleWithCombat().planBasicAttack('b1', 'cmd-1', { teamLabel: 'A', seat: 0 }),
    ).toThrow(NotYourTurnError)
  })

  it('quien no participa tampoco tiene el turno', () => {
    expect(() => battleWithCombat().planBasicAttack('intruso', 'cmd-1', TARGET)).toThrow(
      NotYourTurnError,
    )
  })

  it('el turno activo de un AI nunca lo tiene un humano', () => {
    const room = battleWithCombat({ mode: 'PVE', teamSizes: [1, 1], aiInTeamB: 1, firstTeam: 'B' })

    expect(() => room.planBasicAttack('a1', 'cmd-1', { teamLabel: 'B', seat: 0 })).toThrow(
      NotYourTurnError,
    )
  })

  it('una sala que no esta en batalla: BattleNotInProgressError', () => {
    expect(() => preparingRoom().planBasicAttack('a1', 'cmd-1', TARGET)).toThrow(
      BattleNotInProgressError,
    )
  })

  it.each([
    [{ teamLabel: 'C', seat: 0 }, 'equipo inexistente'],
    [{ teamLabel: 'B', seat: 5 }, 'asiento inexistente'],
    [{ teamLabel: 'b', seat: 0 }, 'equipo con otra capitalizacion'],
  ])('objetivo %j inexistente (%s): InvalidTargetError', (target) => {
    expect(() => battleWithCombat().planBasicAttack('a1', 'cmd-1', target)).toThrow(
      InvalidTargetError,
    )
  })

  it('el propio atacante no es un objetivo valido: SameTeamTargetError', () => {
    expect(() =>
      battleWithCombat().planBasicAttack('a1', 'cmd-1', { teamLabel: 'A', seat: 0 }),
    ).toThrow(SameTeamTargetError)
  })

  it('un aliado tampoco (2v2): SameTeamTargetError, validado antes que cualquier resolucion', () => {
    const room = battleWithCombat({ teamSizes: [2, 2] })

    expect(() => room.planBasicAttack('a1', 'cmd-1', { teamLabel: 'A', seat: 1 })).toThrow(
      SameTeamTargetError,
    )
  })

  it('2v2: cualquiera de los dos rivales es un objetivo valido, uno solo por comando', () => {
    const room = battleWithCombat({ teamSizes: [2, 2] })

    expect(
      ready(room.planBasicAttack('a1', 'cmd-1', { teamLabel: 'B', seat: 0 })).targetEntry.playerId,
    ).toBe('b1')
    expect(
      ready(room.planBasicAttack('a1', 'cmd-2', { teamLabel: 'B', seat: 1 })).targetEntry.playerId,
    ).toBe('b2')
  })

  it('3v3 (HU-12, Issue #21): ningun aliado es objetivo valido, incluido el mas lejano en la cola', () => {
    const room = battleWithCombat({ teamSizes: [3, 3] })

    expect(() => room.planBasicAttack('a1', 'cmd-1', { teamLabel: 'A', seat: 1 })).toThrow(
      SameTeamTargetError,
    )
    expect(() => room.planBasicAttack('a1', 'cmd-2', { teamLabel: 'A', seat: 2 })).toThrow(
      SameTeamTargetError,
    )
  })

  it('3v3 (HU-12, Issue #21): los tres rivales son objetivo valido', () => {
    const room = battleWithCombat({ teamSizes: [3, 3] })

    expect(
      ready(room.planBasicAttack('a1', 'cmd-1', { teamLabel: 'B', seat: 0 })).targetEntry.playerId,
    ).toBe('b1')
    expect(
      ready(room.planBasicAttack('a1', 'cmd-2', { teamLabel: 'B', seat: 1 })).targetEntry.playerId,
    ).toBe('b2')
    expect(
      ready(room.planBasicAttack('a1', 'cmd-3', { teamLabel: 'B', seat: 2 })).targetEntry.playerId,
    ).toBe('b3')
  })

  it('objetivo sin Vida: TargetUnavailableError', () => {
    expect(() =>
      battleWithCombat({ health: { 'B#0': 0 } }).planBasicAttack('a1', 'cmd-1', TARGET),
    ).toThrow(TargetUnavailableError)
  })

  it('atacante sin Vida: ActorUnavailableError', () => {
    expect(() =>
      battleWithCombat({ health: { 'A#0': 0 } }).planBasicAttack('a1', 'cmd-1', TARGET),
    ).toThrow(ActorUnavailableError)
  })

  it('batalla anterior a HU-18 (sin snapshot): perfil no soportado, sin inventar valores', () => {
    expect(() =>
      battleWithCombat({ withCombat: false }).planBasicAttack('a1', 'cmd-1', TARGET),
    ).toThrow(UnsupportedCombatProfileError)
  })

  it('participante AI como objetivo: perfil no soportado (no hay fuente autoritativa de su perfil)', () => {
    const room = battleWithCombat({ mode: 'PVE', teamSizes: [1, 1], aiInTeamB: 1 })

    expect(() => room.planBasicAttack('a1', 'cmd-1', { teamLabel: 'B', seat: 0 })).toThrow(
      UnsupportedCombatProfileError,
    )
  })

  it('sanador (sin Ataque ni Dano): perfil no soportado', () => {
    const healer = combatProfileFixture({ subtype: 'CHAMAN', attack: null, damage: null })

    expect(() =>
      battleWithCombat({ profiles: { a1: healer } }).planBasicAttack('a1', 'cmd-1', TARGET),
    ).toThrow(UnsupportedCombatProfileError)
  })

  it('Dano PERCENTAGE: perfil no soportado (no se inventa una base)', () => {
    const percentage = combatProfileFixture({ damage: { mode: 'PERCENTAGE', basisPoints: 500 } })

    expect(() =>
      battleWithCombat({ profiles: { a1: percentage } }).planBasicAttack('a1', 'cmd-1', TARGET),
    ).toThrow(UnsupportedCombatProfileError)
  })

  it('un sanador SI puede ser objetivo', () => {
    const healer = combatProfileFixture({ subtype: 'MEDICO', attack: null, damage: null })
    const plan = ready(
      battleWithCombat({ profiles: { b1: healer } }).planBasicAttack('a1', 'cmd-1', TARGET),
    )

    expect(plan.targetProfile.subtype).toBe('MEDICO')
  })

  it.each(['', '   ', 'x'.repeat(101)])(
    'commandId invalido %j: InvalidCommandIdError',
    (commandId) => {
      expect(() => battleWithCombat().planBasicAttack('a1', commandId, TARGET)).toThrow(
        InvalidCommandIdError,
      )
    },
  )

  it('el orden de validacion es el del contrato: turno antes que objetivo', () => {
    // Fuera de turno Y con un objetivo inexistente: prevalece NotYourTurn.
    expect(() =>
      battleWithCombat().planBasicAttack('b1', 'cmd-1', { teamLabel: 'Z', seat: 9 }),
    ).toThrow(NotYourTurnError)
  })
})

describe('BattleRoom.applyBasicAttack — UNA sola transicion', () => {
  const applied = (outcome: BasicAttackOutcome, room = battleWithCombat()) => {
    const plan = ready(room.planBasicAttack('a1', 'cmd-1', TARGET))

    return { before: room, after: room.applyBasicAttack(plan, outcome, 'cmd-1', LATER) }
  }

  it('Vida, evento, commandId y turno cambian JUNTOS en la misma version', () => {
    const { before, after } = applied(
      hit({ effect: 'CRITICAL_DAMAGE', percent: 137, baseDamage: 5 }),
    )

    expect(healthOf(after, 'B')).toEqual({ current: 38, max: 44 })
    expect(after.battle?.turnsCompleted).toBe(1)
    expect(after.battleView()?.currentTurn.playerId).toBe('b1')
    expect(after.lastSeq).toBe(2)
    expect(after.handledCommands).toEqual([{ commandId: 'cmd-1', seq: 2 }])
    expect(after.events.at(-1)).toMatchObject({
      seq: 2,
      type: BattleEventType.BasicAttackResolved,
      occurredAt: LATER,
    })
    // La misma version: quien la incrementa es el repositorio al guardar.
    expect(after.version).toBe(before.version)
  })

  it('el evento explica el golpe y trae la Vida y el turno POSTERIORES', () => {
    const { after } = applied(hit({ effect: 'CRITICAL_DAMAGE', percent: 137, baseDamage: 5 }))
    const payload = after.events.at(-1)?.payload as unknown as {
      commandId: string
      completedPosition: number
      attacker: unknown
      target: unknown
      resolution: unknown
      targetHealth: unknown
      battle: { turnsCompleted: number; combatants: unknown[] }
    }

    expect(payload.commandId).toBe('cmd-1')
    expect(payload.completedPosition).toBe(0)
    expect(payload.attacker).toEqual({ teamLabel: 'A', seat: 0 })
    expect(payload.target).toEqual({ teamLabel: 'B', seat: 0 })
    expect(payload.resolution).toEqual({
      attackValue: 14,
      defenseValue: 11,
      effective: true,
      effect: 'CRITICAL_DAMAGE',
      percent: 137,
      baseDamage: 5,
      calculatedDamage: 6,
      appliedDamage: 6,
    })
    expect(payload.targetHealth).toEqual({ before: 44, after: 38 })
    expect(payload.battle.turnsCompleted).toBe(1)
    // HU-19 amplia la vista con `power` y `skills`: aqui solo importa la Vida.
    expect(payload.battle.combatants).toMatchObject([
      { teamLabel: 'A', seat: 0, health: { current: 44, max: 44 } },
      { teamLabel: 'B', seat: 0, health: { current: 38, max: 44 } },
    ])
  })

  it('golpe NO efectivo: la Vida no cambia y el turno SI avanza', () => {
    const { after } = applied(MISS)

    expect(healthOf(after, 'B')).toEqual({ current: 44, max: 44 })
    expect(after.battle?.turnsCompleted).toBe(1)
    expect((after.events.at(-1)?.payload as { resolution: unknown }).resolution).toMatchObject({
      effective: false,
      effect: null,
      percent: null,
      baseDamage: null,
      calculatedDamage: 0,
      appliedDamage: 0,
    })
  })

  it('efecto 0 % (NO_DAMAGE): la Vida no cambia y el turno avanza; no es un error', () => {
    const { after } = applied(hit({ effect: 'NO_DAMAGE', percent: 0, baseDamage: null }))

    expect(healthOf(after, 'B')).toEqual({ current: 44, max: 44 })
    expect(after.battle?.turnsCompleted).toBe(1)
  })

  it('un floor que deja el dano en 0 (3 x 20 %) tampoco es un error: el turno avanza', () => {
    const { after } = applied(hit({ effect: 'ESCAPE', percent: 20, baseDamage: 3 }))

    expect(
      (after.events.at(-1)?.payload as { resolution: { calculatedDamage: number } }).resolution
        .calculatedDamage,
    ).toBe(0)
    expect(healthOf(after, 'B')).toEqual({ current: 44, max: 44 })
    expect(after.battle?.turnsCompleted).toBe(1)
  })

  it.each([
    // [porcentaje, dano base, dano esperado, Vida esperada del objetivo (44)]
    [100, 6, 6, 38],
    [80, 5, 4, 40],
    [60, 5, 3, 41],
    [20, 5, 1, 43],
  ])(
    'efecto %i %% sobre dano base %i: descuenta floor = %i',
    (percent, baseDamage, expectedDamage, expectedHealth) => {
      const { after } = applied(hit({ percent, baseDamage }))

      expect(healthOf(after, 'B')?.current).toBe(expectedHealth)
      expect(
        (after.events.at(-1)?.payload as { resolution: { appliedDamage: number } }).resolution
          .appliedDamage,
      ).toBe(expectedDamage)
    },
  )

  it('overkill: la Vida queda en 0 y el golpe letal finaliza con el evento de la accion intacto', () => {
    const room = battleWithCombat({ health: { 'B#0': 3 } })
    const { after } = applied(hit({ effect: 'CRITICAL_DAMAGE', percent: 180, baseDamage: 6 }), room)

    expect(healthOf(after, 'B')).toEqual({ current: 0, max: 44 })
    // HU-21: el golpe letal anade `battleFinished` DESPUES del evento de la accion,
    // que conserva su resolucion (calculado 10, aplicado 3).
    expect(after.status).toBe('FINISHED')
    expect((after.events.at(-2)?.payload as { resolution: unknown }).resolution).toMatchObject({
      calculatedDamage: 10,
      appliedDamage: 3,
    })
    expect(after.events.at(-1)?.type).toBe(BattleEventType.BattleFinished)
  })

  it('SOLO cambia la Vida del objetivo: el atacante y los demas quedan intactos (2v2)', () => {
    const room = battleWithCombat({ teamSizes: [2, 2] })
    const plan = ready(room.planBasicAttack('a1', 'cmd-1', { teamLabel: 'B', seat: 1 }))
    const after = room.applyBasicAttack(plan, hit({ baseDamage: 4 }), 'cmd-1', LATER)

    expect(healthOf(after, 'B', 1)).toEqual({ current: 40, max: 44 })
    expect(healthOf(after, 'B', 0)).toEqual({ current: 44, max: 44 })
    expect(healthOf(after, 'A', 0)).toEqual({ current: 44, max: 44 })
    expect(healthOf(after, 'A', 1)).toEqual({ current: 44, max: 44 })
  })

  it('es inmutable: la sala original no cambia', () => {
    const { before } = applied(hit())

    expect(healthOf(before, 'B')).toEqual({ current: 44, max: 44 })
    expect(before.battle?.turnsCompleted).toBe(0)
    expect(before.events).toHaveLength(1)
    expect(before.handledCommands).toEqual([])
  })

  it('la cola sigue inmutable: tras el ataque es la MISMA (HU-17)', () => {
    const { before, after } = applied(hit())

    expect(after.battle?.turnOrder).toEqual(before.battle?.turnOrder)
  })

  it('un golpe no efectivo que aporta efecto, porcentaje o dano base es incoherente', () => {
    const room = battleWithCombat()
    const plan = ready(room.planBasicAttack('a1', 'cmd-1', TARGET))

    expect(() =>
      room.applyBasicAttack(plan, { ...MISS, effect: 'DAMAGE' }, 'cmd-1', LATER),
    ).toThrow(DomainError)
    expect(() => room.applyBasicAttack(plan, { ...MISS, percent: 100 }, 'cmd-1', LATER)).toThrow(
      DomainError,
    )
    expect(() => room.applyBasicAttack(plan, { ...MISS, baseDamage: 3 }, 'cmd-1', LATER)).toThrow(
      DomainError,
    )
  })

  it('un porcentaje fuera de 0..180 o un dano base decimal se rechazan', () => {
    const room = battleWithCombat()
    const plan = ready(room.planBasicAttack('a1', 'cmd-1', TARGET))

    expect(() => room.applyBasicAttack(plan, hit({ percent: 181 }), 'cmd-1', LATER)).toThrow(
      DomainError,
    )
    expect(() => room.applyBasicAttack(plan, hit({ baseDamage: 2.5 }), 'cmd-1', LATER)).toThrow(
      DomainError,
    )
  })

  it('el evento del ataque basico no lleva Poder ni recarga propios; sin estado de habilidades la vista los deja vacios', () => {
    const { after } = applied(hit())
    const payload = after.events.at(-1)?.payload as unknown as Record<string, unknown>

    // HU-19: la vista de la batalla ahora lleva `power` y `skills` por participante, pero la ACCION
    // del ataque basico no aporta nada de Poder: ni claves propias en el evento...
    expect(Object.keys(payload).filter((key) => /power|cooldown|skill|bonus/i.test(key))).toEqual(
      [],
    )
    // ...y este perfil es anterior a HU-19 (sin Poder maximo ni habilidades): la vista no inventa valores.
    expect(after.battleView()?.combatants.map(({ power, skills }) => ({ power, skills }))).toEqual([
      { power: null, skills: [] },
      { power: null, skills: [] },
    ])
  })
})

describe('Idempotencia por commandId (HU-18)', () => {
  const played = () => {
    const room = battleWithCombat()
    const plan = ready(room.planBasicAttack('a1', 'cmd-1', TARGET))

    return room.applyBasicAttack(plan, hit(), 'cmd-1', LATER)
  }

  it('repetir el commandId devuelve el evento ya guardado, sin planificar otra vez', () => {
    const after = played()
    const replay = after.planBasicAttack('a1', 'cmd-1', TARGET)

    expect(replay).toEqual({ kind: 'replay', event: after.events.at(-1) })
  })

  it('se reconoce ANTES de validar el turno: tras el ataque el turno ya no es de a1 y el reintento no falla', () => {
    const after = played()

    expect(after.battleView()?.currentTurn.playerId).toBe('b1')
    expect(after.planBasicAttack('a1', 'cmd-1', TARGET).kind).toBe('replay')
  })

  it('un commandId distinto en un turno que ya no es suyo: NotYourTurnError', () => {
    expect(() => played().planBasicAttack('a1', 'cmd-2', TARGET)).toThrow(NotYourTurnError)
  })

  it('un commandId con evento perdido en la bitacora es una inconsistencia, no un reintento silencioso', () => {
    const after = played()
    const broken = after.toSnapshot()
    // El evento del comando falta en la bitacora: la sala restaurada es inconsistente. Se
    // reconstruye con 2 eventos y se le quita el segundo SIN tocar `handledCommands`.
    const restored = BattleRoom.restore({ ...broken, events: broken.events.slice(0, 1) })

    expect(() => restored.planBasicAttack('a1', 'cmd-1', TARGET)).toThrow(DomainError)
  })
})

describe('Snapshot de combate en BattleState', () => {
  const key = (entry: { teamLabel: string; seat: number }): string =>
    `${entry.teamLabel}#${String(entry.seat)}`

  it('la vista lleva la Vida de cada participante, en el orden de la cola, sin perfil', () => {
    const view = battleWithCombat().battleView()

    // Este perfil es anterior a HU-19: sin Poder maximo ni habilidades (`power: null`, `skills: []`).
    expect(view?.combatants).toEqual([
      { teamLabel: 'A', seat: 0, health: { current: 44, max: 44 }, power: null, skills: [] },
      { teamLabel: 'B', seat: 0, health: { current: 44, max: 44 }, power: null, skills: [] },
    ])
    expect(JSON.stringify(view?.combatants)).not.toMatch(
      /attack|defense|damage|effects|maxHealth|heroId/i,
    )
  })

  it('una batalla anterior a HU-18 se restaura SIN Vida (combatants vacio) y sin error', () => {
    const room = battleWithCombat({ withCombat: false })

    expect(room.battle?.combatants).toBeNull()
    expect(room.battleView()?.combatants).toEqual([])
  })

  it('un snapshot ausente al restaurar se trata como una batalla anterior a HU-18', () => {
    const snapshot = battleWithCombat().toSnapshot()
    const battle = snapshot.battle

    if (battle === null) {
      throw new Error('sin batalla')
    }

    // Un documento escrito por HU-17: la batalla no trae `combatants`.
    const legacy = {
      ...snapshot,
      battle: {
        startedAt: battle.startedAt,
        turnOrder: battle.turnOrder,
        turnsCompleted: battle.turnsCompleted,
      },
    }

    expect(BattleRoom.restore(legacy).battleView()?.combatants).toEqual([])
  })

  it('el snapshot debe corresponder EXACTAMENTE a la cola: uno de mas, de menos o repetido se rechaza', () => {
    const room = battleWithCombat()
    const base = room.toSnapshot().battle

    if (base === null) {
      throw new Error('sin batalla')
    }

    const combatants = base.combatants ?? []

    for (const bad of [
      combatants.slice(0, 1),
      [...combatants, { ...combatants[0], seat: 7 }],
      [combatants[0], combatants[0]],
    ]) {
      expect(() => BattleState.restore({ ...base, combatants: bad as never })).toThrow(
        InvalidBattleRosterError,
      )
    }
  })

  it('la Vida debe ser un entero entre 0 y la maxima', () => {
    const profile = combatProfileFixture()

    for (const currentHealth of [-1, 45, 3.5, Number.NaN]) {
      expect(() => Combatant.restore({ teamLabel: 'A', seat: 0, profile, currentHealth })).toThrow(
        DomainError,
      )
    }
  })

  it('un combatiente sin perfil no tiene Vida ni puede cambiarla', () => {
    const ai = Combatant.start({ teamLabel: 'B', seat: 0 }, null)

    expect(ai.currentHealth).toBeNull()
    expect(ai.toView().health).toBeNull()
    expect(ai.alive).toBe(false)
    expect(() => ai.withHealth(3)).toThrow(DomainError)
    expect(() =>
      Combatant.restore({ teamLabel: 'B', seat: 0, profile: null, currentHealth: 4 }),
    ).toThrow(DomainError)
  })

  it('el perfil se congela: ni el perfil ni sus efectos se pueden mutar', () => {
    const profile = createCombatProfile({
      ...combatProfileFixture(),
      activeEffects: [
        {
          sourceProductId: 'p',
          sourceProductReference: 'ref',
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          hasActivationCondition: false,
          appliedToStats: true,
        },
      ],
    })

    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.activeEffects)).toBe(true)
    expect(Object.isFrozen(profile.activeEffects[0])).toBe(true)
  })

  it.each([
    ['maxHealth', { maxHealth: 40.5 }],
    ['maxHealth negativa', { maxHealth: -1 }],
    ['defense decimal', { defense: 3.2 }],
    ['attack decimal', { attack: 10.5 }],
  ])('un dato upstream mal formado (%s) no se corrige en silencio', (_name, overrides) => {
    expect(() => createCombatProfile({ ...combatProfileFixture(), ...overrides })).toThrow(
      InvalidCombatProfileError,
    )
  })

  it('withCombatant reemplaza UNO y no toca la cola ni el contador', () => {
    const room = battleWithCombat({ teamSizes: [2, 2] })
    const state = room.battle

    if (state === null) {
      throw new Error('sin batalla')
    }

    const target = state.combatantFor({ teamLabel: 'B', seat: 1 })
    const next = state.withCombatant(target!.withHealth(10))

    expect(next.combatantFor({ teamLabel: 'B', seat: 1 })?.currentHealth).toBe(10)
    expect(next.combatantFor({ teamLabel: 'B', seat: 0 })?.currentHealth).toBe(44)
    expect(next.turnOrder).toBe(state.turnOrder)
    expect(next.turnsCompleted).toBe(state.turnsCompleted)
    expect(state.combatantFor({ teamLabel: 'B', seat: 1 })?.currentHealth).toBe(44)
    expect(key({ teamLabel: 'B', seat: 1 })).toBe('B#1')
  })

  it('completeTurn conserva el snapshot de combate', () => {
    const state = battleWithCombat().battle

    expect(state?.completeTurn(NOW).combatants).toBe(state?.combatants)
  })

  it('ROOM_ID de los fixtures sigue siendo el battleId de la vista', () => {
    expect(battleWithCombat().battleView()?.battleId).toBe(ROOM_ID)
  })
})
