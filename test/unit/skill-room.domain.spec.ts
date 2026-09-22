import type {
  BasicAttackOutcome,
  BattleRoom,
  SkillOutcome,
  SkillReadyPlan,
} from '../../src/domain/entities/BattleRoom'
import { BattleEventType, type SkillUsedPayload } from '../../src/domain/entities/BattleEvent'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  InvalidCommandIdError,
  InvalidTargetError,
  NotYourTurnError,
  SameTeamTargetError,
  SkillOnCooldownError,
  SkillsNotAvailableError,
  TargetUnavailableError,
  UnknownSkillError,
  UnsupportedCombatProfileError,
  UnsupportedSkillEffectError,
} from '../../src/domain/errors/BattleErrors'
import { DomainError } from '../../src/domain/errors/DomainError'
import { NOW, preparingRoom } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'
import {
  EMBATE_ID,
  LOTUS_ID,
  SHIELD_STRIKE,
  SHIELD_STRIKE_ID,
  STONE_HAND_ID,
  STORM,
  STORM_ID,
  battleWithSkills,
  skillProfile,
} from '../fixtures/skills'

/**
 * Habilidad en el AGREGADO (HU-19): validacion previa SIN aleatoriedad y una unica transicion
 * atomica (Vida + Poder + recarga + evento + commandId + turno). Contrato `hu-19-skills-v1`.
 */
const TARGET_B = { teamLabel: 'B', seat: 0 }
const TARGET_A = { teamLabel: 'A', seat: 0 }
const LATER = new Date(NOW.getTime() + 5_000)

const skillPlan = (
  room: BattleRoom,
  actor: string,
  command: string,
  ability: string,
): SkillReadyPlan => {
  const plan = room.planSkill(actor, command, ability, actor === 'a1' ? TARGET_B : TARGET_A)

  if (plan.kind !== 'skill') {
    throw new Error(`se esperaba un plan de habilidad y llego ${plan.kind}`)
  }

  return plan
}

const outcome = (overrides: Partial<SkillOutcome> = {}): SkillOutcome => ({
  attackValue: 14,
  defenseValue: 11,
  effective: true,
  effect: 'DAMAGE',
  percent: 100,
  baseDamage: 5,
  attackBonus: 2,
  damageBonus: 0,
  ...overrides,
})

const MISS: SkillOutcome = {
  attackValue: 11,
  defenseValue: 11,
  effective: false,
  effect: null,
  percent: null,
  baseDamage: null,
  attackBonus: 2,
  damageBonus: null,
}

const useSkill = (
  room: BattleRoom,
  actor: string,
  command: string,
  ability: string,
  result: SkillOutcome = outcome(),
): BattleRoom => room.applySkill(skillPlan(room, actor, command, ability), result, command, LATER)

const basicHit: BasicAttackOutcome = {
  attackValue: 14,
  defenseValue: 11,
  effective: true,
  effect: 'DAMAGE',
  percent: 100,
  baseDamage: 3,
}

const attack = (room: BattleRoom, actor: string, command: string): BattleRoom => {
  const plan = room.planBasicAttack(actor, command, actor === 'a1' ? TARGET_B : TARGET_A)

  if (plan.kind !== 'ready') {
    throw new Error('se esperaba un plan de ataque')
  }

  return room.applyBasicAttack(plan, basicHit, command, LATER)
}

const viewOf = (room: BattleRoom, label: string) => {
  const found = room.battleView()?.combatants.find((combatant) => combatant.teamLabel === label)

  if (found === undefined) {
    throw new Error('sin combatiente en la vista')
  }

  return found
}

/**
 * Payload de la ULTIMA habilidad ejecutada. HU-21: tras un golpe letal la sala
 * anade `battleFinished` como ultimo evento, asi que buscar `skillUsed` es mas
 * preciso que leer el ultimo evento a ciegas.
 */
const payloadOf = (room: BattleRoom): SkillUsedPayload =>
  room.events.filter((event) => event.type === BattleEventType.SkillUsed).at(-1)
    ?.payload as SkillUsedPayload

describe('BattleRoom.planSkill — validacion previa (0 sorteos)', () => {
  it('una habilidad valida: costo, bonos y Poder antes y despues salen del snapshot', () => {
    const plan = skillPlan(battleWithSkills(), 'a1', 'cmd-1', SHIELD_STRIKE_ID)

    expect(plan.ability.name).toBe('Golpe con escudo')
    expect(plan.attackBonus).toEqual({ fixed: 2, dice: [] })
    expect(plan.damageBonus).toEqual({ fixed: 0, dice: [] })
    expect(plan.powerBefore).toBe(10)
    expect(plan.powerAfter).toBe(8)
    expect(plan.targetHealth).toBe(44)
    expect(plan.damage).toEqual({ mode: 'DICE', count: 1, sides: 6 })
    expect(plan.attackerEntry).toMatchObject({ teamLabel: 'A', seat: 0, playerId: 'a1' })
    expect(plan.targetEntry).toMatchObject({ teamLabel: 'B', seat: 0, playerId: 'b1' })
  })

  it('planificar NO muta la sala', () => {
    const room = battleWithSkills()
    const before = JSON.stringify(room.toSnapshot())

    room.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B)

    expect(JSON.stringify(room.toSnapshot())).toBe(before)
  })

  it.each(['', '   ', 'x'.repeat(101)])(
    'un commandId invalido (%p) es InvalidCommandIdError',
    (commandId) => {
      expect(() =>
        battleWithSkills().planSkill('a1', commandId, SHIELD_STRIKE_ID, TARGET_B),
      ).toThrow(InvalidCommandIdError)
    },
  )

  it('una sala sin batalla en curso: BattleNotInProgressError', () => {
    expect(() => preparingRoom().planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B)).toThrow(
      BattleNotInProgressError,
    )
  })

  it('fuera de turno: NotYourTurnError; un no participante tampoco tiene el turno', () => {
    expect(() => battleWithSkills().planSkill('b1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_A)).toThrow(
      NotYourTurnError,
    )
    expect(() =>
      battleWithSkills().planSkill('intruso', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B),
    ).toThrow(NotYourTurnError)
  })

  it('un objetivo que no existe: InvalidTargetError; uno del propio equipo (incluido el actor): SameTeamTargetError', () => {
    const room = battleWithSkills()

    expect(() =>
      room.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, { teamLabel: 'Z', seat: 0 }),
    ).toThrow(InvalidTargetError)
    expect(() => room.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_A)).toThrow(
      SameTeamTargetError,
    )
  })

  it('un objetivo sin Vida: TargetUnavailableError; un actor sin Vida: ActorUnavailableError', () => {
    expect(() =>
      battleWithSkills({ health: { 'B#0': 0 } }).planSkill(
        'a1',
        'cmd-1',
        SHIELD_STRIKE_ID,
        TARGET_B,
      ),
    ).toThrow(TargetUnavailableError)
    expect(() =>
      battleWithSkills({ health: { 'A#0': 0 } }).planSkill(
        'a1',
        'cmd-1',
        SHIELD_STRIKE_ID,
        TARGET_B,
      ),
    ).toThrow(ActorUnavailableError)
  })

  it('un objetivo AI (sin perfil): UnsupportedCombatProfileError', () => {
    const room = battleWithSkills({ mode: 'PVE', teamSizes: [1, 1], aiInTeamB: 1 })

    expect(() => room.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B)).toThrow(
      UnsupportedCombatProfileError,
    )
  })

  it('una batalla iniciada antes de HU-19 (sin Poder ni habilidades): SkillsNotAvailableError; el ataque basico sigue', () => {
    const old = battleWithCombat()

    expect(() => old.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B)).toThrow(
      SkillsNotAvailableError,
    )
    expect(old.planBasicAttack('a1', 'cmd-1', TARGET_B).kind).toBe('ready')
  })

  it('una batalla sin snapshot de combate: UnsupportedCombatProfileError (no hay perfil)', () => {
    const none = battleWithCombat({ withCombat: false })

    expect(() => none.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B)).toThrow(
      UnsupportedCombatProfileError,
    )
  })

  it('CA-02: una habilidad que no es del heroe (de otra clase, o inexistente): UnknownSkillError', () => {
    const room = battleWithSkills({
      profiles: { a1: skillProfile({ abilities: [SHIELD_STRIKE] }), b1: skillProfile() },
    })

    // Flor de loto es de otra clase: existe en el Catalog pero NO en el heroe de a1.
    expect(() => room.planSkill('a1', 'cmd-1', LOTUS_ID, TARGET_B)).toThrow(UnknownSkillError)
    expect(() =>
      room.planSkill('a1', 'cmd-1', '99999999-9999-4999-8999-999999999999', TARGET_B),
    ).toThrow(UnknownSkillError)
  })

  it('la habilidad de OTRO participante no vale aunque exista en la batalla', () => {
    const room = battleWithSkills({
      profiles: {
        a1: skillProfile({ abilities: [SHIELD_STRIKE] }),
        b1: skillProfile({ abilities: [STORM] }),
      },
    })

    expect(() => room.planSkill('a1', 'cmd-1', STORM_ID, TARGET_B)).toThrow(UnknownSkillError)
  })

  it('un efecto no soportado: UnsupportedSkillEffectError con su motivo; no se degrada a ataque basico', () => {
    const room = battleWithSkills()

    try {
      room.planSkill('a1', 'cmd-1', STONE_HAND_ID, TARGET_B)
      throw new Error('debio lanzar')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(UnsupportedSkillEffectError)
      expect((error as UnsupportedSkillEffectError).code).toBe('UNSUPPORTED_SKILL_EFFECT')
      // El motivo es el PRIMER incumplimiento (la Defensa se evalua antes que la duracion).
      expect((error as UnsupportedSkillEffectError).reason).toMatch(/estadistica DEFENSE/)
    }
  })

  it('una habilidad no soportada se rechaza ANTES de hablar de Poder: con Poder 0 no se fuerza un ataque por ella', () => {
    const room = battleWithSkills({
      profiles: { a1: skillProfile({ maxPower: 0 }), b1: skillProfile() },
    })

    expect(() => room.planSkill('a1', 'cmd-1', STONE_HAND_ID, TARGET_B)).toThrow(
      UnsupportedSkillEffectError,
    )
  })

  it('CA-03 y frontera: con el Poder EXACTO se ejecuta y queda en 0', () => {
    const room = battleWithSkills({
      profiles: { a1: skillProfile({ maxPower: 2 }), b1: skillProfile() },
    })
    const plan = skillPlan(room, 'a1', 'cmd-1', SHIELD_STRIKE_ID)

    expect(plan.powerBefore).toBe(2)
    expect(plan.powerAfter).toBe(0)
  })

  it('HU-11 y frontera: con un punto menos del costo la accion se DEGRADA (no es un error) y no muta nada', () => {
    const room = battleWithSkills({
      profiles: { a1: skillProfile({ maxPower: 1 }), b1: skillProfile() },
    })
    const before = JSON.stringify(room.toSnapshot())

    expect(room.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B)).toEqual({
      kind: 'degraded',
      abilityId: SHIELD_STRIKE_ID,
    })
    expect(JSON.stringify(room.toSnapshot())).toBe(before)
  })

  it('ALL_AVAILABLE: consume todo el saldo; con saldo 0 no hay nada que consumir y se degrada', () => {
    const allIn = { ...SHIELD_STRIKE, powerCost: { mode: 'ALL_AVAILABLE' } as const }
    const seven = battleWithSkills({
      profiles: { a1: skillProfile({ maxPower: 7, abilities: [allIn] }), b1: skillProfile() },
    })
    const zero = battleWithSkills({
      profiles: { a1: skillProfile({ maxPower: 0, abilities: [allIn] }), b1: skillProfile() },
    })

    expect(skillPlan(seven, 'a1', 'cmd-1', SHIELD_STRIKE_ID)).toMatchObject({
      powerBefore: 7,
      powerAfter: 0,
    })
    expect(zero.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B).kind).toBe('degraded')
  })

  it('un heroe sin Ataque numerico no puede ejecutar una habilidad de ataque: UnsupportedCombatProfileError', () => {
    const healer = battleWithSkills({
      profiles: { a1: skillProfile({ attack: null, damage: null }), b1: skillProfile() },
    })

    expect(() => healer.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B)).toThrow(
      UnsupportedCombatProfileError,
    )
  })

  it('un commandId ya procesado devuelve el evento guardado ANTES de validar turno o habilidad', () => {
    const after = useSkill(battleWithSkills(), 'a1', 'cmd-1', SHIELD_STRIKE_ID)
    // Tras la accion el turno es de b1: un reintento de a1 no debe fallar por eso.
    const replay = after.planSkill('a1', 'cmd-1', 'cualquier-cosa', TARGET_A)

    expect(replay.kind).toBe('replay')
    expect(replay.kind === 'replay' && replay.event.seq).toBe(2)
  })
})

describe('BattleRoom.planSkill — orden entre recarga y Poder', () => {
  it('la recarga se comprueba ANTES que el Poder: en recarga e insuficiente es SkillOnCooldownError, no degradacion', () => {
    // Golpe de tormenta cuesta 6: con 6 de Poder queda en 0; tras el turno de b1 regenera +2 (< 6).
    let room = battleWithSkills({
      profiles: { a1: skillProfile({ maxPower: 6 }), b1: skillProfile() },
    })

    room = useSkill(room, 'a1', 'cmd-1', STORM_ID)
    room = attack(room, 'b1', 'cmd-2')

    expect(() => room.planSkill('a1', 'cmd-3', STORM_ID, TARGET_B)).toThrow(SkillOnCooldownError)
  })
})

describe('BattleRoom.applySkill — UNA sola transicion atomica', () => {
  it('Vida, Poder, recarga, evento, commandId y turno cambian juntos en UNA version nueva', () => {
    const room = battleWithSkills()
    const after = useSkill(room, 'a1', 'cmd-1', SHIELD_STRIKE_ID)

    // Vida del objetivo: 44 - 5.
    expect(viewOf(after, 'B').health).toEqual({ current: 39, max: 44 })
    // Poder del actor: 10 - 2.
    expect(viewOf(after, 'A').power).toEqual({ current: 8, max: 10 })
    // Recarga marcada: chargeTurns (1) y estado RECHARGING.
    expect(viewOf(after, 'A').skills[0]).toMatchObject({
      cooldownRemaining: 1,
      status: 'RECHARGING',
    })
    // Turno avanzado.
    expect(after.battle?.turnsCompleted).toBe(1)
    expect(after.battleView()?.currentTurn.playerId).toBe('b1')
    // Evento con su seq y commandId procesado.
    expect(after.events.at(-1)).toMatchObject({ seq: 2, type: BattleEventType.SkillUsed })
    expect(after.handledCommands).toEqual([{ commandId: 'cmd-1', seq: 2 }])
    // La sala original no se toco.
    expect(room.battle?.turnsCompleted).toBe(0)
    expect(room.events).toHaveLength(1)
  })

  it('el evento explica la accion: habilidad, Poder antes/despues, recarga, bono y resolucion', () => {
    const after = useSkill(
      battleWithSkills(),
      'a1',
      'cmd-1',
      SHIELD_STRIKE_ID,
      outcome({ attackValue: 17, baseDamage: 6, attackBonus: 2, damageBonus: 0 }),
    )
    const payload = payloadOf(after)

    expect(payload.commandId).toBe('cmd-1')
    expect(payload.completedPosition).toBe(0)
    expect(payload.actor).toEqual({ teamLabel: 'A', seat: 0 })
    expect(payload.target).toEqual({ teamLabel: 'B', seat: 0 })
    expect(payload.skill).toEqual({
      abilityId: SHIELD_STRIKE_ID,
      name: 'Golpe con escudo',
      powerCost: { mode: 'FIXED', amount: 2 },
      chargeTurns: 1,
    })
    expect(payload.power).toEqual({ before: 10, after: 8 })
    expect(payload.cooldown).toEqual({ remainingTurns: 1 })
    expect(payload.bonus).toEqual({ attack: 2, damage: 0 })
    expect(payload.resolution).toEqual({
      attackValue: 17,
      defenseValue: 11,
      effective: true,
      effect: 'DAMAGE',
      percent: 100,
      baseDamage: 6,
      calculatedDamage: 6,
      appliedDamage: 6,
    })
    expect(payload.targetHealth).toEqual({ before: 44, after: 38 })
  })

  it('el evento persistido es identico a lo que la vista posterior dice (mismo battle)', () => {
    const after = useSkill(battleWithSkills(), 'a1', 'cmd-1', SHIELD_STRIKE_ID)

    expect(payloadOf(after).battle).toEqual(after.battleView())
  })

  it('un golpe NO efectivo: el Poder se gasta y la recarga se marca igualmente (CA-01, CA-09); la Vida no cambia', () => {
    const after = useSkill(battleWithSkills(), 'a1', 'cmd-1', SHIELD_STRIKE_ID, MISS)

    expect(viewOf(after, 'B').health?.current).toBe(44)
    expect(viewOf(after, 'A').power?.current).toBe(8)
    expect(viewOf(after, 'A').skills[0]?.cooldownRemaining).toBe(1)
    expect(after.battle?.turnsCompleted).toBe(1)
    expect(payloadOf(after).bonus).toEqual({ attack: 2, damage: null })
  })

  it('un efecto del 0 % no causa dano pero gasta Poder y marca la recarga', () => {
    const after = useSkill(
      battleWithSkills(),
      'a1',
      'cmd-1',
      SHIELD_STRIKE_ID,
      outcome({ effect: 'NO_DAMAGE', percent: 0, baseDamage: null, damageBonus: null }),
    )

    expect(viewOf(after, 'B').health?.current).toBe(44)
    expect(viewOf(after, 'A').power?.current).toBe(8)
  })

  it('el dano se acota a la Vida restante (overkill) y la Vida queda en 0', () => {
    const after = useSkill(
      battleWithSkills({ health: { 'B#0': 3 } }),
      'a1',
      'cmd-1',
      SHIELD_STRIKE_ID,
      outcome({ baseDamage: 9 }),
    )

    expect(viewOf(after, 'B').health?.current).toBe(0)
    expect(payloadOf(after).resolution).toMatchObject({ calculatedDamage: 9, appliedDamage: 3 })
    expect(payloadOf(after).targetHealth).toEqual({ before: 3, after: 0 })
  })

  it('el dano es floor(dano base x porcentaje / 100) sobre el dano base ya con el bono', () => {
    const after = useSkill(
      battleWithSkills(),
      'a1',
      'cmd-1',
      SHIELD_STRIKE_ID,
      outcome({ effect: 'CRITICAL_DAMAGE', percent: 137, baseDamage: 5, damageBonus: 1 }),
    )

    expect(payloadOf(after).resolution).toMatchObject({ calculatedDamage: 6, appliedDamage: 6 })
  })

  it('un resultado inconsistente (no efectivo con dano base o con bono de dano) se rechaza', () => {
    const room = battleWithSkills()
    const plan = skillPlan(room, 'a1', 'cmd-1', SHIELD_STRIKE_ID)

    expect(() => room.applySkill(plan, { ...MISS, baseDamage: 4 }, 'cmd-1', LATER)).toThrow(
      DomainError,
    )
    expect(() => room.applySkill(plan, { ...MISS, damageBonus: 1 }, 'cmd-1', LATER)).toThrow(
      DomainError,
    )
    expect(() => room.applySkill(plan, { ...MISS, effect: 'DAMAGE' }, 'cmd-1', LATER)).toThrow(
      DomainError,
    )
  })

  it('aplicar sobre una sala sin batalla en curso lanza', () => {
    const room = battleWithSkills()
    const plan = skillPlan(room, 'a1', 'cmd-1', SHIELD_STRIKE_ID)

    expect(() => preparingRoom().applySkill(plan, outcome(), 'cmd-1', LATER)).toThrow(
      BattleNotInProgressError,
    )
  })

  it('el Poder del actor y el del objetivo no se mezclan: solo cambia el del actor', () => {
    const after = useSkill(battleWithSkills(), 'a1', 'cmd-1', STORM_ID)

    expect(viewOf(after, 'A').power?.current).toBe(4)
    expect(viewOf(after, 'B').power?.current).toBe(10)
  })

  it('el siguiente participante recibe +2 de Poder al comenzar su turno (con tope)', () => {
    let room = battleWithSkills()

    room = useSkill(room, 'a1', 'cmd-1', STORM_ID)
    // b1 gasta 6: queda en 4. Al abrirse el turno de a1 esta regenera +2 (4 -> 6).
    room = useSkill(room, 'b1', 'cmd-2', STORM_ID)

    expect(viewOf(room, 'B').power?.current).toBe(4)
    expect(viewOf(room, 'A').power?.current).toBe(6)
  })

  it('el ataque basico NO consume Poder ni marca recarga (HU-18/HU-11), pero si cierra la recarga del atacante', () => {
    let room = battleWithSkills()

    room = useSkill(room, 'a1', 'cmd-1', STORM_ID) // 10 - 6 = 4
    room = attack(room, 'b1', 'cmd-2') // al abrirse el turno de a1: 4 + 2 = 6
    const powerBefore = viewOf(room, 'A').power?.current
    const cooldownBefore = viewOf(room, 'A').skills.find((s) => s.abilityId === STORM_ID)

    room = attack(room, 'a1', 'cmd-3')

    // El ataque basico no gasta ni recupera Poder del atacante: sigue en 6.
    expect(powerBefore).toBe(6)
    expect(viewOf(room, 'A').power?.current).toBe(6)
    // Recarga: 1 antes de su turno, 0 despues de cerrarlo con un ataque basico.
    expect(cooldownBefore?.cooldownRemaining).toBe(1)
    expect(
      viewOf(room, 'A').skills.find((skill) => skill.abilityId === STORM_ID)?.cooldownRemaining,
    ).toBe(0)
  })

  it('un ataque basico degradado por Poder insuficiente lleva degradedFrom y deja Poder y recarga intactos', () => {
    const room = battleWithSkills({
      profiles: { a1: skillProfile({ maxPower: 1 }), b1: skillProfile() },
    })
    const plan = room.planSkill('a1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_B)
    const basic = room.planBasicAttack('a1', 'cmd-1', TARGET_B)

    expect(plan.kind).toBe('degraded')
    if (basic.kind !== 'ready') {
      throw new Error('se esperaba un plan de ataque')
    }
    const after = room.applyBasicAttack(basic, basicHit, 'cmd-1', LATER, {
      command: 'useSkill',
      abilityId: SHIELD_STRIKE_ID,
      reason: 'INSUFFICIENT_POWER',
    })

    expect(after.events.at(-1)?.type).toBe(BattleEventType.BasicAttackResolved)
    expect(after.events.at(-1)?.payload).toMatchObject({
      degradedFrom: {
        command: 'useSkill',
        abilityId: SHIELD_STRIKE_ID,
        reason: 'INSUFFICIENT_POWER',
      },
    })
    expect(viewOf(after, 'A').power?.current).toBe(1)
    expect(viewOf(after, 'A').skills[0]?.cooldownRemaining).toBe(0)
    expect(after.battle?.turnsCompleted).toBe(1)
  })

  it('un ataque basico normal NO lleva degradedFrom', () => {
    const after = attack(battleWithSkills(), 'a1', 'cmd-1')

    expect(after.events.at(-1)?.payload).not.toHaveProperty('degradedFrom')
  })
})

describe('Recarga a lo largo de los turnos (CA-04, CA-06, CA-07; contrato §5.3)', () => {
  it('con chargeTurns 1: usada en T, bloqueada en T + 1 y disponible en T + 2', () => {
    let room = battleWithSkills()

    room = useSkill(room, 'a1', 'cmd-1', SHIELD_STRIKE_ID) // T (turno propio 1)
    room = attack(room, 'b1', 'cmd-2')

    // Turno propio 2 de a1: sigue bloqueada.
    expect(viewOf(room, 'A').skills[0]).toMatchObject({
      cooldownRemaining: 1,
      status: 'RECHARGING',
    })
    expect(() => room.planSkill('a1', 'cmd-3', SHIELD_STRIKE_ID, TARGET_B)).toThrow(
      SkillOnCooldownError,
    )

    room = attack(room, 'a1', 'cmd-3')
    room = attack(room, 'b1', 'cmd-4')

    // Turno propio 3: disponible otra vez.
    expect(viewOf(room, 'A').skills[0]).toMatchObject({ cooldownRemaining: 0, status: 'READY' })
    expect(room.planSkill('a1', 'cmd-5', SHIELD_STRIKE_ID, TARGET_B).kind).toBe('skill')
  })

  it('con chargeTurns 2 (como la epica): bloqueada en T + 1 y T + 2, disponible en T + 3', () => {
    const slow = { ...SHIELD_STRIKE, chargeTurns: 2 }
    let room = battleWithSkills({
      profiles: { a1: skillProfile({ abilities: [slow] }), b1: skillProfile() },
    })

    room = useSkill(room, 'a1', 'cmd-1', SHIELD_STRIKE_ID)
    expect(viewOf(room, 'A').skills[0]?.cooldownRemaining).toBe(2)

    const blockedTurns: number[] = []
    for (let own = 2; own <= 3; own += 1) {
      room = attack(room, 'b1', `b-${String(own)}`)
      blockedTurns.push(viewOf(room, 'A').skills[0]?.cooldownRemaining ?? -1)
      expect(() => room.planSkill('a1', `a-${String(own)}`, SHIELD_STRIKE_ID, TARGET_B)).toThrow(
        SkillOnCooldownError,
      )
      room = attack(room, 'a1', `a-${String(own)}`)
    }

    room = attack(room, 'b1', 'b-4')

    expect(blockedTurns).toEqual([2, 1])
    expect(room.planSkill('a1', 'a-4', SHIELD_STRIKE_ID, TARGET_B).kind).toBe('skill')
  })

  it('usar OTRA habilidad no altera la recarga de la primera ni la libera', () => {
    let room = battleWithSkills()

    room = useSkill(room, 'a1', 'cmd-1', SHIELD_STRIKE_ID)
    room = attack(room, 'b1', 'cmd-2')
    room = useSkill(room, 'a1', 'cmd-3', EMBATE_ID)
    room = attack(room, 'b1', 'cmd-4')

    // Golpe con escudo ya cerro su recarga (dos turnos propios despues); Embate sigue en recarga.
    expect(viewOf(room, 'A').skills.map((skill) => [skill.name, skill.cooldownRemaining])).toEqual([
      ['Golpe con escudo', 0],
      ['Embate sangriento', 1],
      ['Golpe de tormenta', 0],
      ['Flor de loto', 0],
      ['Mano de piedra', 0],
    ])
  })

  it('un cambio de la version del agregado por una accion rechazada no marca recarga: planificar no persiste nada', () => {
    const room = battleWithSkills()

    expect(() => room.planSkill('b1', 'cmd-1', SHIELD_STRIKE_ID, TARGET_A)).toThrow(
      NotYourTurnError,
    )
    expect(viewOf(room, 'A').skills[0]?.cooldownRemaining).toBe(0)
    expect(viewOf(room, 'A').power?.current).toBe(10)
  })
})
