import { BattleDecisionStateAssembler } from '../../src/application/services/BattleDecisionStateAssembler'
import { LegalActionGenerator } from '../../src/application/services/LegalActionGenerator'
import { isLegalActionIntent, resolveLegalAction } from '../../src/domain/decision/ActionIdentity'
import { battleWithCombat } from '../fixtures/basic-attack'
import { finishedRoom, preparingRoom, ROOM_ID } from '../fixtures/battle'
import { battleWithSkills, SHIELD_STRIKE_ID, skillProfile, STONE_HAND_ID } from '../fixtures/skills'
import { battleWithEpic, EPICA_DANO, EPICA_DANO_ID, GOLPE_DE_DEFENSA_EPIC } from '../fixtures/epic'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'

describe('EN-035.2 decision contract', () => {
  it('assembles an immutable, versioned state from the current combat snapshot without personal or RNG data', () => {
    const room = battleWithCombat()
    const state = new BattleDecisionStateAssembler().assemble(room)

    expect(state).toMatchObject({
      schemaVersion: 1,
      context: { battleId: ROOM_ID, mode: 'PVP', round: 1, turnsCompleted: 0 },
      actor: {
        identity: { teamLabel: 'A', seat: 0 },
        kind: 'HUMAN',
        health: { current: 44, max: 44 },
      },
      allies: [],
      enemies: [{ identity: { teamLabel: 'B', seat: 0 }, health: { current: 44, max: 44 } }],
    })
    expect(JSON.stringify(state)).not.toMatch(
      /playerId|displayName|email|jwt|token|seed|nextRandom|randomCursor|mongo/iu,
    )
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.actor)).toBe(true)
    expect(Object.isFrozen(state.enemies)).toBe(true)
  })

  it('exposes the equipped epic and its current cooldown from the frozen combat profile', () => {
    const original = battleWithEpic(GOLPE_DE_DEFENSA_EPIC)
    const snapshot = original.toSnapshot()
    const battle = snapshot.battle

    if (battle?.combatants == null) {
      throw new Error('fixture de batalla incompleta')
    }

    const combatants = battle.combatants.map((combatant) =>
      combatant.teamLabel === 'A'
        ? {
            ...combatant,
            cooldowns: { ...combatant.cooldowns, [GOLPE_DE_DEFENSA_EPIC.epicProductId]: 1 },
          }
        : combatant,
    )
    const room = BattleRoom.restore({ ...snapshot, battle: { ...battle, combatants } })
    const state = new BattleDecisionStateAssembler().assemble(room)

    expect(state.actor.epic).toEqual({
      epicId: GOLPE_DE_DEFENSA_EPIC.epicProductId,
      powerCost: GOLPE_DE_DEFENSA_EPIC.powerCost,
      cooldownTurns: GOLPE_DE_DEFENSA_EPIC.cooldownTurns,
      cooldownRemaining: 1,
    })
  })

  it('generates basic attack candidates only for valid opponents in stable order without mutating the room', () => {
    const room = battleWithCombat({ teamSizes: [1, 2] })
    const before = room.toSnapshot()
    const generator = new LegalActionGenerator()

    const actions = generator.generate(room)

    expect(actions.map((action) => action.kind)).toEqual(['BASIC_ATTACK', 'BASIC_ATTACK'])
    expect(actions.map((action) => action.target)).toEqual([
      { teamLabel: 'B', seat: 0 },
      { teamLabel: 'B', seat: 1 },
    ])
    expect(Object.isFrozen(actions[0]?.target)).toBe(true)
    expect(generator.generate(room)).toEqual(actions)
    expect(room.toSnapshot()).toEqual(before)
  })

  it('resolves only an intent that matches one canonical legal candidate', () => {
    const actions = new LegalActionGenerator().generate(battleWithCombat())
    const action = actions[0]

    expect(action).toBeDefined()
    expect(
      resolveLegalAction({ kind: 'BASIC_ATTACK', target: { teamLabel: 'B', seat: 0 } }, actions),
    ).toEqual(action)
    expect(() =>
      resolveLegalAction({ kind: 'BASIC_ATTACK', target: { teamLabel: 'A', seat: 0 } }, actions),
    ).toThrow()
    expect(
      isLegalActionIntent({ kind: 'BASIC_ATTACK', target: { teamLabel: 'A', seat: 0 } }, actions),
    ).toBe(false)
  })

  it('includes supported skills with valid targets, but excludes unsupported effects and skills that only degrade to basic attack', () => {
    const actions = new LegalActionGenerator().generate(battleWithSkills())

    expect(actions).toContainEqual({
      kind: 'ABILITY',
      abilityId: SHIELD_STRIKE_ID,
      target: { teamLabel: 'B', seat: 0 },
    })
    expect(
      actions.some(
        (action) =>
          action.kind === 'ABILITY' &&
          action.abilityId === SHIELD_STRIKE_ID &&
          Object.isFrozen(action.target),
      ),
    ).toBe(true)
    expect(
      actions.some((action) => action.kind === 'ABILITY' && action.abilityId === STONE_HAND_ID),
    ).toBe(false)

    const lowPower = battleWithSkills({
      profiles: { a1: skillProfile({ maxPower: 1 }), b1: skillProfile() },
    })
    expect(
      new LegalActionGenerator()
        .generate(lowPower)
        .some((action) => action.kind === 'ABILITY' && action.abilityId === SHIELD_STRIKE_ID),
    ).toBe(false)
  })

  it('excludes a supported skill while Combat says its cooldown is active', () => {
    const original = battleWithSkills()
    const snapshot = original.toSnapshot()
    const battle = snapshot.battle
    if (battle?.combatants == null) {
      throw new Error('fixture de batalla incompleta')
    }
    const combatants = battle.combatants.map((combatant) =>
      combatant.teamLabel === 'A'
        ? { ...combatant, cooldowns: { ...combatant.cooldowns, [SHIELD_STRIKE_ID]: 1 } }
        : combatant,
    )
    const room = BattleRoom.restore({ ...snapshot, battle: { ...battle, combatants } })
    const actions = new LegalActionGenerator().generate(room)

    expect(
      actions.some((action) => action.kind === 'ABILITY' && action.abilityId === SHIELD_STRIKE_ID),
    ).toBe(false)
  })

  it('does not invent pass/skip when the current state has no legal target', () => {
    expect(() =>
      new LegalActionGenerator().generate(battleWithCombat({ health: { 'B#0': 0 } })),
    ).toThrow(/no contiene acciones legales/u)
  })

  it('includes executable equipped epics and omits unsupported epics', () => {
    const legal = new LegalActionGenerator().generate(battleWithEpic(GOLPE_DE_DEFENSA_EPIC))
    expect(legal).toContainEqual({
      kind: 'EPIC',
      epicId: GOLPE_DE_DEFENSA_EPIC.epicProductId,
      target: null,
    })

    const targeted = new LegalActionGenerator().generate(battleWithEpic(EPICA_DANO))
    expect(targeted).toContainEqual({
      kind: 'EPIC',
      epicId: EPICA_DANO_ID,
      target: { teamLabel: 'B', seat: 0 },
    })
    expect(
      targeted.some(
        (action) =>
          action.kind === 'EPIC' &&
          action.epicId === EPICA_DANO_ID &&
          action.target !== null &&
          Object.isFrozen(action.target),
      ),
    ).toBe(true)

    const [damageEffect] = EPICA_DANO.executableEffects
    if (damageEffect === undefined) throw new Error('fixture de épica incompleta')
    const unsupported = { ...EPICA_DANO, executableEffects: [{ ...damageEffect, kind: 'UNKNOWN' }] }
    expect(
      new LegalActionGenerator()
        .generate(battleWithEpic(unsupported))
        .some((action) => action.kind === 'EPIC'),
    ).toBe(false)
  })

  it('rejects rooms before combat and after combat, while the assembler can represent a structural AI actor', () => {
    const assembler = new BattleDecisionStateAssembler()
    expect(() => assembler.assemble(preparingRoom())).toThrow()
    expect(() => assembler.assemble(finishedRoom())).toThrow()

    const aiActor = battleWithCombat({ aiInTeamA: 1 })
    expect(assembler.assemble(aiActor).actor.kind).toBe('AI')
    expect(() => new LegalActionGenerator().generate(aiActor)).toThrow(/HU-93/u)
    expect(() => assembler.assemble(battleWithCombat(), { teamLabel: 'B', seat: 0 })).toThrow(
      /turno vigente/u,
    )
  })
})
