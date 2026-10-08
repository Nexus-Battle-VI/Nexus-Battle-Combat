import { BattleEventType, type BattleEvent } from '../../src/domain/entities/BattleEvent'
import type { CombatantKey } from '../../src/domain/entities/Combatant'
import {
  extractDamage,
  extractHeal,
  extractPowerAfter,
} from '../../src/evaluation/battle/EvaluationMetricsExtraction'

const A: CombatantKey = { teamLabel: 'A', seat: 0 }
const B: CombatantKey = { teamLabel: 'B', seat: 0 }
const BATTLE_VIEW = {} as unknown

const event = (type: BattleEvent['type'], payload: unknown): BattleEvent =>
  ({ seq: 1, type, occurredAt: new Date('2027-01-01T00:00:00.000Z'), payload }) as BattleEvent

describe('EvaluationMetricsExtraction (EN-036.5, Management #569 §48-53)', () => {
  it('MT-01: basicAttackResolved se atribuye como dano real (appliedDamage, nunca calculatedDamage)', () => {
    const e = event(BattleEventType.BasicAttackResolved, {
      commandId: 'c1',
      completedPosition: 0,
      attacker: A,
      target: B,
      resolution: {
        attackValue: 11,
        defenseValue: 5,
        effective: true,
        effect: 'NORMAL',
        percent: 100,
        baseDamage: 6,
        calculatedDamage: 6,
        appliedDamage: 4,
      },
      targetHealth: { before: 4, after: 0 },
      battle: BATTLE_VIEW,
    })

    expect(extractDamage(e)).toEqual({ attacker: A, target: B, amount: 4 })
    expect(extractHeal(e)).toBeNull()
    expect(extractPowerAfter(e)).toBeNull()
  })

  it('MT-02: skillUsed con resolucion se atribuye como dano real y reporta Poder', () => {
    const e = event(BattleEventType.SkillUsed, {
      commandId: 'c1',
      completedPosition: 0,
      actor: A,
      target: B,
      skill: { abilityId: 'storm', name: 'Tormenta', powerCost: { mode: 'FIXED', amount: 6 }, chargeTurns: 1 },
      power: { before: 10, after: 4 },
      cooldown: { remainingTurns: 0 },
      bonus: { attack: 9, damage: 2 },
      resolution: {
        attackValue: 20,
        defenseValue: 5,
        effective: true,
        effect: 'NORMAL',
        percent: 100,
        baseDamage: 15,
        calculatedDamage: 15,
        appliedDamage: 15,
      },
      targetHealth: { before: 44, after: 29 },
      battle: BATTLE_VIEW,
    })

    expect(extractDamage(e)).toEqual({ attacker: A, target: B, amount: 15 })
    expect(extractPowerAfter(e)).toEqual({ actor: A, after: 4 })
  })

  it('MT-03: healSkillUsed NUNCA cuenta como dano, y reporta curacion por objetivo', () => {
    const e = event(BattleEventType.HealSkillUsed, {
      commandId: 'c1',
      completedPosition: 0,
      actor: A,
      target: A,
      skill: { abilityId: 'life-touch', name: 'Toque de la Vida', powerCost: { mode: 'FIXED', amount: 3 }, chargeTurns: 1 },
      power: { before: 10, after: 7 },
      cooldown: { remainingTurns: 0 },
      heal: { amount: 2 },
      targetHealth: { before: 20, after: 22 },
      battle: BATTLE_VIEW,
    })

    expect(extractDamage(e)).toBeNull()
    expect(extractHeal(e)).toEqual({ actor: A, targets: [A], amountPerTarget: 2 })
  })

  it('healSkillUsed de grupo (affected) reporta TODOS los afectados, cada uno con el mismo monto', () => {
    const ally2: CombatantKey = { teamLabel: 'A', seat: 1 }
    const e = event(BattleEventType.HealSkillUsed, {
      commandId: 'c1',
      completedPosition: 0,
      actor: A,
      target: A,
      skill: { abilityId: 'forest-song', name: 'Canto del Bosque', powerCost: { mode: 'FIXED', amount: 6 }, chargeTurns: 1 },
      power: { before: 10, after: 4 },
      cooldown: { remainingTurns: 0 },
      heal: { amount: 4 },
      targetHealth: { before: 20, after: 24 },
      affected: [A, ally2],
      battle: BATTLE_VIEW,
    })

    expect(extractHeal(e)).toEqual({ actor: A, targets: [A, ally2], amountPerTarget: 4 })
  })

  it('directDamageSkillUsed se atribuye con appliedDamage, sin resolucion de Ataque/Defensa', () => {
    const e = event(BattleEventType.DirectDamageSkillUsed, {
      commandId: 'c1',
      completedPosition: 0,
      actor: A,
      target: B,
      skill: { abilityId: 'agony', name: 'Agonia', powerCost: { mode: 'FIXED', amount: 3 }, chargeTurns: 1 },
      power: { before: 10, after: 7 },
      cooldown: { remainingTurns: 0 },
      damage: { calculatedDamage: 11, appliedDamage: 9 },
      targetHealth: { before: 9, after: 0 },
      battle: BATTLE_VIEW,
    })

    expect(extractDamage(e)).toEqual({ attacker: A, target: B, amount: 9 })
  })

  it('epicUsed con damage se atribuye; epicUsed sin damage/heal (solo SELF) no es atribuible', () => {
    const withDamage = event(BattleEventType.EpicUsed, {
      commandId: 'c1',
      completedPosition: 0,
      actor: A,
      target: B,
      epic: { epicProductId: 'epic-dano', name: 'Epica de dano' },
      power: { before: 0, after: 0 },
      cooldown: { remainingTurns: 2 },
      appliedEffects: 1,
      damage: { calculatedDamage: 9, appliedDamage: 9 },
      targetHealth: { before: 20, after: 11 },
      battle: BATTLE_VIEW,
    })
    const selfOnly = event(BattleEventType.EpicUsed, {
      commandId: 'c2',
      completedPosition: 0,
      actor: A,
      epic: { epicProductId: 'golpe-defensa', name: 'Golpe de defensa' },
      power: { before: 0, after: 0 },
      cooldown: { remainingTurns: 2 },
      appliedEffects: 3,
      battle: BATTLE_VIEW,
    })

    expect(extractDamage(withDamage)).toEqual({ attacker: A, target: B, amount: 9 })
    expect(extractDamage(selfOnly)).toBeNull()
    expect(extractHeal(selfOnly)).toBeNull()
    expect(extractPowerAfter(selfOnly)).toEqual({ actor: A, after: 0 })
  })

  it('turnAdvanced/battleFinished no transportan dano, curacion ni Poder', () => {
    const turnAdvanced = event(BattleEventType.TurnAdvanced, { completedPosition: 0, battle: BATTLE_VIEW })
    expect(extractDamage(turnAdvanced)).toBeNull()
    expect(extractHeal(turnAdvanced)).toBeNull()
    expect(extractPowerAfter(turnAdvanced)).toBeNull()
  })
})
