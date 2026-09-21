import type { BattleState } from '../../src/domain/entities/BattleState'
import { Combatant } from '../../src/domain/entities/Combatant'
import { createCombatProfile } from '../../src/domain/entities/CombatProfile'
import { DomainError } from '../../src/domain/errors/DomainError'
import { InvalidCombatProfileError } from '../../src/domain/errors/BattleErrors'
import { battleWithCombat, combatProfileFixture } from '../fixtures/basic-attack'
import {
  EMBATE,
  EMBATE_ID,
  SHIELD_STRIKE,
  SHIELD_STRIKE_ID,
  STONE_HAND,
  STONE_HAND_ID,
  STORM_ID,
  battleWithSkills,
  skillProfile,
} from '../fixtures/skills'

/**
 * Estado runtime de UN participante (HU-19): Poder actual, recarga de sus habilidades y como se
 * ve desde el cliente. Contrato `hu-19-skills-v1` §5.
 */
const KEY_A = { teamLabel: 'A', seat: 0 } as const

describe('CombatProfile — Poder maximo y habilidades congelados (HU-19)', () => {
  it('conserva maxPower y abilities, y las congela (inmutables)', () => {
    const profile = skillProfile()

    expect(profile.maxPower).toBe(10)
    expect(profile.abilities).toHaveLength(5)
    expect(Object.isFrozen(profile.abilities)).toBe(true)
    expect(Object.isFrozen(profile.abilities?.[0])).toBe(true)
    expect(Object.isFrozen(profile.abilities?.[0]?.effects)).toBe(true)
    expect(Object.isFrozen(profile.abilities?.[0]?.effects[0])).toBe(true)
  })

  it('un perfil anterior a HU-19 (sin maxPower ni abilities) sigue siendo valido y no se rellena', () => {
    const profile = combatProfileFixture()

    expect(profile).not.toHaveProperty('maxPower')
    expect(profile).not.toHaveProperty('abilities')
  })

  it.each([
    ['maxPower decimal', { maxPower: 2.5 }],
    ['maxPower negativo', { maxPower: -1 }],
  ])('rechaza un perfil con %s', (_label, change) => {
    expect(() => skillProfile(change)).toThrow(InvalidCombatProfileError)
  })

  it.each([
    ['un abilityId con punto (clave de documento no valida)', { abilityId: 'a.b' }],
    ['un abilityId con $', { abilityId: '$a' }],
    ['un abilityId vacio', { abilityId: '' }],
    ['un nombre en blanco', { name: '   ' }],
    ['un costo FIXED de 0', { powerCost: { mode: 'FIXED', amount: 0 } }],
    ['un costo FIXED decimal', { powerCost: { mode: 'FIXED', amount: 1.5 } }],
    ['un costo con modo desconocido', { powerCost: { mode: 'NONE' } }],
    ['una recarga de 0', { chargeTurns: 0 }],
    ['una recarga decimal', { chargeTurns: 1.5 }],
    ['una recarga absurda (> 100)', { chargeTurns: 101 }],
    ['unos efectos que no son una lista', { effects: {} }],
    ['un efecto sin kind', { effects: [{ target: 'SELF', hasActivationCondition: false }] }],
    [
      'un efecto con hasActivationCondition no booleano',
      { effects: [{ kind: 'X', target: 'SELF' }] },
    ],
    [
      'un efecto con durationTurns 0',
      { effects: [{ kind: 'X', target: 'SELF', durationTurns: 0, hasActivationCondition: false }] },
    ],
  ])('rechaza una habilidad con %s', (_label, change) => {
    expect(() => skillProfile({ abilities: [{ ...SHIELD_STRIKE, ...change } as never] })).toThrow(
      InvalidCombatProfileError,
    )
  })

  it('rechaza dos habilidades con el mismo abilityId', () => {
    expect(() =>
      skillProfile({ abilities: [SHIELD_STRIKE, { ...EMBATE, abilityId: SHIELD_STRIKE_ID }] }),
    ).toThrow(InvalidCombatProfileError)
  })

  it('no comparte referencias con lo que recibe (copia defensiva)', () => {
    const effects = [...SHIELD_STRIKE.effects]
    const source = { ...SHIELD_STRIKE, effects }
    const profile = createCombatProfile({
      ...combatProfileFixture(),
      maxPower: 5,
      abilities: [source],
    })

    expect(profile.abilities?.[0]).not.toBe(source)
    expect(profile.abilities?.[0]?.effects).not.toBe(effects)
  })
})

describe('Combatant — Poder y recarga (invariantes)', () => {
  it('inicia con el Poder completo y sin recargas', () => {
    const combatant = Combatant.start(KEY_A, skillProfile())

    expect(combatant.currentPower).toBe(10)
    expect(combatant.cooldowns).toEqual({})
    expect(combatant.hasSkillState).toBe(true)
  })

  it('un perfil anterior a HU-19 no tiene estado de habilidades ni Poder', () => {
    const combatant = Combatant.start(KEY_A, combatProfileFixture())

    expect(combatant.currentPower).toBeNull()
    expect(combatant.hasSkillState).toBe(false)
    expect(combatant.abilities).toEqual([])
    expect(combatant.toSnapshot()).not.toHaveProperty('currentPower')
    expect(combatant.toSnapshot()).not.toHaveProperty('cooldowns')
  })

  it('un participante sin perfil (AI) no tiene Vida, Poder ni recargas', () => {
    const ai = Combatant.start({ teamLabel: 'B', seat: 0 }, null)

    expect(ai.currentPower).toBeNull()
    expect(ai.toView()).toEqual({ teamLabel: 'B', seat: 0, health: null, power: null, skills: [] })
  })

  it.each([
    ['un Poder mayor que el maximo', { currentPower: 11 }],
    ['un Poder negativo', { currentPower: -1 }],
    ['un Poder decimal', { currentPower: 4.5 }],
    ['un Poder ausente con un perfil que declara maxPower', { currentPower: null }],
    ['una recarga de una habilidad que el heroe no tiene', { cooldowns: { 'no-existe': 1 } }],
    ['una recarga de 0 (no se guarda)', { cooldowns: { [SHIELD_STRIKE_ID]: 0 } }],
    ['una recarga decimal', { cooldowns: { [SHIELD_STRIKE_ID]: 1.5 } }],
    ['una recarga mayor que chargeTurns + 1', { cooldowns: { [SHIELD_STRIKE_ID]: 3 } }],
  ])('restore rechaza %s', (_label, change) => {
    expect(() =>
      Combatant.restore({ ...Combatant.start(KEY_A, skillProfile()).toSnapshot(), ...change }),
    ).toThrow(DomainError)
  })

  it('restore rechaza Poder o recargas en un combatiente anterior a HU-19', () => {
    const base = Combatant.start(KEY_A, combatProfileFixture()).toSnapshot()

    expect(() => Combatant.restore({ ...base, currentPower: 5 })).toThrow(DomainError)
    expect(() => Combatant.restore({ ...base, cooldowns: { [SHIELD_STRIKE_ID]: 1 } })).toThrow(
      DomainError,
    )
  })

  it('restore rechaza Poder o recargas en un combatiente sin perfil', () => {
    const base = { teamLabel: 'B', seat: 0, currentHealth: null, profile: null }

    expect(() => Combatant.restore({ ...base, currentPower: 5 })).toThrow(DomainError)
    expect(() => Combatant.restore({ ...base, cooldowns: { [SHIELD_STRIKE_ID]: 1 } })).toThrow(
      DomainError,
    )
  })

  it('el snapshot de un combatiente con estado de habilidades lo lleva y se restaura igual', () => {
    const combatant = Combatant.start(KEY_A, skillProfile()).withPower(7).withCooldown(EMBATE_ID, 1)
    const restored = Combatant.restore(JSON.parse(JSON.stringify(combatant.toSnapshot())))

    expect(restored.currentPower).toBe(7)
    expect(restored.cooldownOf(EMBATE_ID)).toBe(1)
    expect(restored.cooldownOf(SHIELD_STRIKE_ID)).toBe(0)
  })

  it('withPower y withCooldown devuelven OTRO combatiente y no mutan el original', () => {
    const start = Combatant.start(KEY_A, skillProfile())
    const powered = start.withPower(3)
    const cooled = start.withCooldown(SHIELD_STRIKE_ID, 2)

    expect(powered).not.toBe(start)
    expect(start.currentPower).toBe(10)
    expect(cooled.cooldownOf(SHIELD_STRIKE_ID)).toBe(2)
    expect(start.cooldownOf(SHIELD_STRIKE_ID)).toBe(0)
  })

  it('withPower / withCooldown sin estado de habilidades lanzan', () => {
    const old = Combatant.start(KEY_A, combatProfileFixture())

    expect(() => old.withPower(1)).toThrow(DomainError)
    expect(() => old.withCooldown(SHIELD_STRIKE_ID, 1)).toThrow(DomainError)
  })

  it('cambiar la Vida conserva el Poder y las recargas', () => {
    const combatant = Combatant.start(KEY_A, skillProfile())
      .withPower(6)
      .withCooldown(EMBATE_ID, 1)
      .withHealth(20)

    expect(combatant.currentHealth).toBe(20)
    expect(combatant.currentPower).toBe(6)
    expect(combatant.cooldownOf(EMBATE_ID)).toBe(1)
  })
})

describe('Combatant — regeneracion de Poder al comenzar el turno propio (HU-11: +2 con tope)', () => {
  it.each([
    [0, 2],
    [3, 5],
    [8, 10],
    [9, 10],
  ])('con %i de Poder pasa a %i', (before, after) => {
    expect(
      Combatant.start(KEY_A, skillProfile()).withPower(before).openOwnTurn().currentPower,
    ).toBe(after)
  })

  it('con el Poder al maximo no cambia (mismo objeto: nada que regenerar)', () => {
    const full = Combatant.start(KEY_A, skillProfile())

    expect(full.openOwnTurn()).toBe(full)
  })

  it('el tope es el maximo del propio heroe, no un valor global', () => {
    const small = Combatant.start(KEY_A, skillProfile({ maxPower: 3 })).withPower(2)

    expect(small.openOwnTurn().currentPower).toBe(3)
  })

  it('sin estado de habilidades (batalla anterior a HU-19) o sin perfil no hay nada que regenerar', () => {
    const old = Combatant.start(KEY_A, combatProfileFixture())
    const ai = Combatant.start(KEY_A, null)

    expect(old.openOwnTurn()).toBe(old)
    expect(ai.openOwnTurn()).toBe(ai)
  })
})

describe('Combatant — cierre del turno propio y recarga (contrato §5.3)', () => {
  it('a cada habilidad en recarga le falta un turno menos', () => {
    const closed = Combatant.start(KEY_A, skillProfile())
      .withCooldown(SHIELD_STRIKE_ID, 2)
      .withCooldown(EMBATE_ID, 1)
      .closeOwnTurn()

    expect(closed.cooldownOf(SHIELD_STRIKE_ID)).toBe(1)
    // La que llega a 0 vuelve a estar disponible y deja de guardarse.
    expect(closed.cooldownOf(EMBATE_ID)).toBe(0)
    expect(closed.cooldowns).toEqual({ [SHIELD_STRIKE_ID]: 1 })
  })

  it('sin recargas no hay nada que cerrar (mismo objeto)', () => {
    const idle = Combatant.start(KEY_A, skillProfile())

    expect(idle.closeOwnTurn()).toBe(idle)
  })

  it('no toca el Poder ni la Vida', () => {
    const closed = Combatant.start(KEY_A, skillProfile())
      .withPower(4)
      .withCooldown(STORM_ID, 2)
      .closeOwnTurn()

    expect(closed.currentPower).toBe(4)
    expect(closed.currentHealth).toBe(44)
  })
})

describe('Combatant.toView — lo que ve el cliente (contrato §5.4)', () => {
  it('lleva Vida, Poder y habilidades con su estado, en el orden del heroe', () => {
    const view = Combatant.start(KEY_A, skillProfile())
      .withPower(8)
      .withCooldown(EMBATE_ID, 1)
      .toView()

    expect(view.health).toEqual({ current: 44, max: 44 })
    expect(view.power).toEqual({ current: 8, max: 10 })
    expect(view.skills.map((skill) => [skill.name, skill.status, skill.cooldownRemaining])).toEqual(
      [
        ['Golpe con escudo', 'READY', 0],
        ['Embate sangriento', 'RECHARGING', 1],
        ['Golpe de tormenta', 'READY', 0],
        ['Flor de loto', 'READY', 0],
        ['Mano de piedra', 'UNSUPPORTED', 0],
      ],
    )
    expect(view.skills[0]).toEqual({
      abilityId: SHIELD_STRIKE_ID,
      name: 'Golpe con escudo',
      powerCost: { mode: 'FIXED', amount: 2 },
      chargeTurns: 1,
      cooldownRemaining: 0,
      status: 'READY',
    })
  })

  it('el Poder NO cambia el estado de una habilidad: con Poder 0 sigue READY (la accion se degrada)', () => {
    const view = Combatant.start(KEY_A, skillProfile()).withPower(0).toView()

    expect(view.skills[0]?.status).toBe('READY')
  })

  it('una habilidad no soportada se ve UNSUPPORTED aunque este en recarga', () => {
    const view = Combatant.start(KEY_A, skillProfile()).withCooldown(STONE_HAND_ID, 1).toView()

    expect(view.skills.find((skill) => skill.abilityId === STONE_HAND_ID)?.status).toBe(
      'UNSUPPORTED',
    )
  })

  it('NUNCA lleva los efectos de la habilidad, ni Ataque, Defensa, Dano ni el perfil', () => {
    const json = JSON.stringify(Combatant.start(KEY_A, skillProfile()).toView())

    expect(json).not.toMatch(
      /effects|statistic|operation|magnitude|hasActivationCondition|durationTurns/,
    )
    expect(json).not.toMatch(/attack|defense|damage|heroId|maxHealth|activeEffects/i)
  })

  it('un combatiente anterior a HU-19 se ve con power null y skills vacio (no se inventan valores)', () => {
    expect(Combatant.start(KEY_A, combatProfileFixture()).toView()).toMatchObject({
      power: null,
      skills: [],
    })
  })
})

describe('BattleState.completeTurn — cierra el turno propio y abre el siguiente (contrato §5)', () => {
  const stateOf = (room = battleWithSkills()): BattleState => {
    if (room.battle === null) {
      throw new Error('sin batalla')
    }

    return room.battle
  }

  const combatant = (state: BattleState, teamLabel: string): Combatant => {
    const found = state.combatantFor({ teamLabel, seat: 0 })

    if (found === undefined) {
      throw new Error('sin combatiente')
    }

    return found
  }

  it('cierra las recargas de quien termina el turno y regenera +2 al siguiente', () => {
    const start = stateOf()
    const withState = start
      .withCombatant(combatant(start, 'A').withCooldown(SHIELD_STRIKE_ID, 1).withPower(5))
      .withCombatant(combatant(start, 'B').withPower(4))

    const next = withState.completeTurn()

    // A termina su turno: su recarga se cierra, su Poder no cambia.
    expect(combatant(next, 'A').cooldownOf(SHIELD_STRIKE_ID)).toBe(0)
    expect(combatant(next, 'A').currentPower).toBe(5)
    // B comienza el suyo: recupera +2.
    expect(combatant(next, 'B').currentPower).toBe(6)
  })

  it('el primer turno no regenera nada: la batalla inicia con el Poder completo', () => {
    const next = stateOf().completeTurn()

    expect(combatant(next, 'B').currentPower).toBe(10)
  })

  it('en 2 contra 2 solo se tocan quien termina y quien comienza', () => {
    const room = battleWithSkills({
      teamSizes: [2, 2],
      profiles: { a1: skillProfile(), a2: skillProfile(), b1: skillProfile(), b2: skillProfile() },
    })
    const start = stateOf(room)
    const low = (label: string, seat: number): Combatant => {
      const found = start.combatantFor({ teamLabel: label, seat })

      if (found === undefined) {
        throw new Error('sin combatiente')
      }

      return found.withPower(1).withCooldown(SHIELD_STRIKE_ID, 1)
    }
    let state = start
    for (const [label, seat] of [
      ['A', 0],
      ['A', 1],
      ['B', 0],
      ['B', 1],
    ] as const) {
      state = state.withCombatant(low(label, seat))
    }

    const next = state.completeTurn()
    const seen = (label: string, seat: number): { power: number | null; cooldown: number } => {
      const found = next.combatantFor({ teamLabel: label, seat })

      return {
        power: found?.currentPower ?? null,
        cooldown: found?.cooldownOf(SHIELD_STRIKE_ID) ?? -1,
      }
    }

    // Termina el primero de la cola (recarga 1 -> 0) y comienza el segundo (+2 de Poder).
    const order = state.turnOrder.map((entry) => `${entry.teamLabel}${String(entry.seat)}`)
    const finishing = order[0]
    const starting = order[1]

    for (const key of order) {
      const label = key.slice(0, 1)
      const seat = Number(key.slice(1))
      const expected = {
        power: key === starting ? 3 : 1,
        cooldown: key === finishing ? 0 : 1,
      }

      expect(seen(label, seat)).toEqual(expected)
    }
  })

  it('una batalla anterior a HU-19 conserva el snapshot TAL CUAL (misma referencia)', () => {
    const old = stateOf(battleWithCombat())

    expect(old.completeTurn().combatants).toBe(old.combatants)
  })

  it('una batalla sin snapshot de combate avanza igual y sigue sin combatientes', () => {
    const none = stateOf(battleWithCombat({ withCombat: false }))

    expect(none.completeTurn().combatants).toBeNull()
    expect(none.completeTurn().turnsCompleted).toBe(1)
  })

  it('el Poder regenerado nunca supera el maximo', () => {
    const start = stateOf()
    const almostFull = start.withCombatant(combatant(start, 'B').withPower(9))

    expect(combatant(almostFull.completeTurn(), 'B').currentPower).toBe(10)
  })
})

describe('Una recarga de N turnos se cierra en N cierres del turno propio', () => {
  it.each([1, 2, 3])(
    'con chargeTurns %i: bloqueada N turnos propios y libre en el N + 1',
    (turns) => {
      // Se marca con N + 1 (como hace `applySkill`) y cada cierre del turno propio descuenta uno.
      let actor = Combatant.start(
        KEY_A,
        skillProfile({ abilities: [{ ...STONE_HAND, chargeTurns: turns }] }),
      )
        .withCooldown(STONE_HAND_ID, turns + 1)
        .closeOwnTurn()
      const blocked: number[] = []

      for (let own = 1; own <= turns + 1; own += 1) {
        blocked.push(actor.cooldownOf(STONE_HAND_ID))
        actor = actor.closeOwnTurn()
      }

      // En el turno propio 1..N sigue bloqueada (N, N-1, ..., 1); en el N + 1 esta libre (0).
      expect(blocked).toEqual([
        ...Array.from({ length: turns }, (_value, index) => turns - index),
        0,
      ])
    },
  )
})
