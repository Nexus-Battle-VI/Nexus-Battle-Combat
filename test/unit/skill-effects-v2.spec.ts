import type {
  BattleRoom,
  DirectDamageOutcome,
  HealingOutcome,
  SkillDirectDamageReadyPlan,
  SkillHealingReadyPlan,
  SkillOutcome,
  SkillReadyPlan,
} from '../../src/domain/entities/BattleRoom'
import { BattleEventType, type HealSkillUsedPayload } from '../../src/domain/entities/BattleEvent'
import { Combatant } from '../../src/domain/entities/Combatant'
import { battleWithCombat, combatProfileFixture } from '../fixtures/basic-attack'
import { NOW } from '../fixtures/battle'
import {
  AGONY_FIXED,
  AGONY_FIXED_ID,
  FIRE_WARD,
  FIRE_WARD_ID,
  FOREST_SONG_FIXED,
  FOREST_SONG_FIXED_ID,
  ICE_CONE_FIXED,
  ICE_CONE_FIXED_ID,
  LIFE_TOUCH,
  LIFE_TOUCH_ID,
  STONE_FIST,
  STONE_FIST_ID,
  skillProfile,
} from '../fixtures/skills'

/**
 * HU-19 v2 (contrato `hu-19-skills-v2`): cobertura de lo NUEVO sobre v1 -- estadistica DEFENSE,
 * efectos temporales de batalla (contrato §2), dano directo (§3), sanacion generalizada y de
 * grupo (§1/§4) y reflejo de dano (§6). Al nivel del AGREGADO, con `outcome`s FABRICADOS (mismo
 * patron que `skill-room.domain.spec.ts`): lo que se prueba aqui es la MECANICA de estado, no la
 * resolucion de HU-20/HU-25 (ya cubierta) ni el sorteo (cubierto en `use-skill.spec.ts` /
 * `hu-19-skills-guards.spec.ts`).
 */
const LATER = new Date(NOW.getTime() + 1_000)
const TARGET_A = { teamLabel: 'A', seat: 0 } as const
const TARGET_B = { teamLabel: 'B', seat: 0 } as const
const TARGET_A1 = { teamLabel: 'A', seat: 1 } as const

/**
 * Cierra el turno activo de `actor` SIN resolver ninguna accion (HU-17 `BattleRoom.completeTurn`):
 * sirve para avanzar turnos en las pruebas sin depender de que el actor tenga Ataque numerico
 * (los sanadores no lo tienen) ni de fabricar un `BasicAttackOutcome`.
 */
const passTurn = (room: BattleRoom, actor: string): BattleRoom =>
  room.completeTurn(actor, `pass-${actor}-${String(room.lastSeq)}`, LATER)

const combatantOf = (room: BattleRoom, teamLabel: string, seat = 0): Combatant => {
  const found = room.battle?.combatantFor({ teamLabel, seat })

  if (found === undefined) {
    throw new Error('sin combatiente en el snapshot de combate')
  }

  return found
}

describe('Combatant — efectos temporales activos y memoria de dano (HU-19 v2, contrato §2/§6)', () => {
  const KEY = { teamLabel: 'A', seat: 0 } as const

  it('un efecto de estadistica ajusta statBonus; INCREASE y DECREASE se compensan', () => {
    const combatant = Combatant.start(KEY, skillProfile()).withAddedActiveSkillEffects([
      {
        sourceAbilityId: STONE_FIST_ID,
        sourceCombatant: KEY,
        statistic: 'DEFENSE',
        operation: 'INCREASE',
        amount: 12,
        remainingOwnTurns: 2,
      },
      {
        sourceAbilityId: 'otra',
        sourceCombatant: KEY,
        statistic: 'DEFENSE',
        operation: 'DECREASE',
        amount: 5,
        remainingOwnTurns: 1,
      },
    ])

    expect(combatant.statBonus('DEFENSE')).toBe(7)
    expect(combatant.statBonus('ATTACK')).toBe(0)
  })

  it('closeOwnTurn decrementa remainingOwnTurns UNA vez y retira el efecto al llegar a 0 (no se reaplica)', () => {
    const combatant = Combatant.start(KEY, skillProfile()).withAddedActiveSkillEffects([
      {
        sourceAbilityId: STONE_FIST_ID,
        sourceCombatant: KEY,
        statistic: 'DEFENSE',
        operation: 'INCREASE',
        amount: 12,
        remainingOwnTurns: 2,
      },
    ])

    const afterFirstClose = combatant.closeOwnTurn()

    expect(afterFirstClose.activeSkillEffects).toEqual([
      expect.objectContaining({ remainingOwnTurns: 1 }),
    ])
    expect(afterFirstClose.statBonus('DEFENSE')).toBe(12)

    const afterSecondClose = afterFirstClose.closeOwnTurn()

    expect(afterSecondClose.activeSkillEffects).toEqual([])
    expect(afterSecondClose.statBonus('DEFENSE')).toBe(0)
  })

  it('un efecto de HEALING activo aplica su tick al cerrar el turno propio, acotado al maximo', () => {
    const combatant = Combatant.start(KEY, skillProfile())
      .withHealth(40)
      .withAddedActiveSkillEffects([
        {
          sourceAbilityId: 'vinculo',
          sourceCombatant: { teamLabel: 'B', seat: 0 },
          statistic: 'HEALING',
          operation: 'INCREASE',
          amount: 10,
          remainingOwnTurns: 2,
        },
      ])

    const ticked = combatant.closeOwnTurn()

    expect(ticked.currentHealth).toBe(44) // 40 + 10, acotado al maximo (44)
    expect(ticked.activeSkillEffects[0]).toMatchObject({ remainingOwnTurns: 1 })
  })

  it('sin efectos ni recargas, closeOwnTurn no toca nada (mismo objeto)', () => {
    const combatant = Combatant.start(KEY, skillProfile())

    expect(combatant.closeOwnTurn()).toBe(combatant)
  })

  it('withDamageTaken refresca la memoria (no acumula) y closeOwnTurn la expira en 1 turno propio', () => {
    const hit = Combatant.start(KEY, skillProfile()).withDamageTaken(6)

    expect(hit.damageMemory).toEqual({ amount: 6, remainingOwnTurns: 1 })

    const refreshed = hit.withDamageTaken(9)

    expect(refreshed.damageMemory).toEqual({ amount: 9, remainingOwnTurns: 1 })
    expect(refreshed.closeOwnTurn().damageMemory).toBeNull()
  })

  it('withDamageTaken con 0 o sin estado de habilidades no crea memoria', () => {
    expect(Combatant.start(KEY, skillProfile()).withDamageTaken(0).damageMemory).toBeNull()
    expect(Combatant.start(KEY, combatProfileFixture()).withDamageTaken(5).damageMemory).toBeNull()
  })

  it('el snapshot de un combatiente con efectos activos y memoria de dano se restaura igual (JSON puro)', () => {
    const combatant = Combatant.start(KEY, skillProfile())
      .withAddedActiveSkillEffects([
        {
          sourceAbilityId: STONE_FIST_ID,
          sourceCombatant: KEY,
          statistic: 'DEFENSE',
          operation: 'INCREASE',
          amount: 12,
          remainingOwnTurns: 2,
        },
      ])
      .withDamageTaken(4)
    const restored = Combatant.restore(JSON.parse(JSON.stringify(combatant.toSnapshot())))

    expect(restored.statBonus('DEFENSE')).toBe(12)
    expect(restored.damageMemory).toEqual({ amount: 4, remainingOwnTurns: 1 })
  })

  it('CombatantView (toView) NUNCA lleva efectos temporales ni memoria de dano', () => {
    const combatant = Combatant.start(KEY, skillProfile())
      .withAddedActiveSkillEffects([
        {
          sourceAbilityId: STONE_FIST_ID,
          sourceCombatant: KEY,
          statistic: 'DEFENSE',
          operation: 'INCREASE',
          amount: 12,
          remainingOwnTurns: 2,
        },
      ])
      .withDamageTaken(4)

    expect(JSON.stringify(combatant.toView())).not.toMatch(
      /activeSkillEffects|remainingOwnTurns|damageMemory|sourceAbilityId/,
    )
  })
})

describe('BattleRoom — DEFENSE temporal (Mano de piedra, contrato §1/§2)', () => {
  const setup = (): BattleRoom =>
    battleWithCombat({ profiles: { a1: skillProfile({ abilities: [STONE_FIST] }) } })

  it('planSkill produce UN efecto temporal SELF con remainingOwnTurns = 1 (sin durationTurns declarado)', () => {
    const room = setup()
    const plan = room.planSkill('a1', 'cmd-1', STONE_FIST_ID, TARGET_B) as SkillReadyPlan

    expect(plan.kind).toBe('skill')
    expect(plan.temporalEffects).toHaveLength(1)
    expect(plan.temporalEffects[0]).toMatchObject({
      targetKey: { teamLabel: 'A', seat: 0 },
      initialRemainingOwnTurns: 1,
    })
  })

  it('usar la habilidad adjunta el efecto DEFENSE al actor y expira tras su SIGUIENTE turno propio', () => {
    const room = setup()
    const plan = room.planSkill('a1', 'cmd-1', STONE_FIST_ID, TARGET_B) as SkillReadyPlan
    const outcome: SkillOutcome = {
      attackValue: 20,
      defenseValue: 5,
      effective: false,
      effect: null,
      percent: null,
      baseDamage: null,
      attackBonus: 0,
      damageBonus: null,
      resolvedTemporalEffects: [
        {
          targetKey: plan.attackerEntry,
          effect: {
            sourceAbilityId: STONE_FIST_ID,
            sourceCombatant: plan.attackerEntry,
            statistic: 'DEFENSE',
            operation: 'INCREASE',
            amount: 12,
            remainingOwnTurns: 1,
          },
        },
      ],
    }

    // El efecto se adjunta DESPUES de `completeTurn`: el cierre de turno de ESTA MISMA
    // transicion no lo alcanza, sigue en 1 (sin decrementar).
    const next = room.applySkill(plan, outcome, 'cmd-1', LATER)

    expect(combatantOf(next, 'A').statBonus('DEFENSE')).toBe(12)
    expect(combatantOf(next, 'A').activeSkillEffects).toEqual([
      expect.objectContaining({ remainingOwnTurns: 1 }),
    ])

    // b1 pasa (no afecta el efecto de A); a1 pasa (CIERRA su propio turno: el efecto expira aqui).
    const afterB = passTurn(next, 'b1')
    const afterA = passTurn(afterB, 'a1')

    expect(combatantOf(afterA, 'A').statBonus('DEFENSE')).toBe(0)
  })

  it('un commandId repetido no reaplica ni duplica el efecto (idempotencia, contrato §2)', () => {
    const room = setup()
    const plan = room.planSkill('a1', 'cmd-1', STONE_FIST_ID, TARGET_B) as SkillReadyPlan
    const outcome: SkillOutcome = {
      attackValue: 20,
      defenseValue: 5,
      effective: false,
      effect: null,
      percent: null,
      baseDamage: null,
      attackBonus: 0,
      damageBonus: null,
      resolvedTemporalEffects: [
        {
          targetKey: plan.attackerEntry,
          effect: {
            sourceAbilityId: STONE_FIST_ID,
            sourceCombatant: plan.attackerEntry,
            statistic: 'DEFENSE',
            operation: 'INCREASE',
            amount: 12,
            remainingOwnTurns: 2,
          },
        },
      ],
    }

    const once = room.applySkill(plan, outcome, 'cmd-1', LATER)
    const replay = once.planSkill('a1', 'cmd-1', STONE_FIST_ID, TARGET_B)

    expect(replay.kind).toBe('replay')
    expect(combatantOf(once, 'A').activeSkillEffects).toHaveLength(1)
  })
})

describe('BattleRoom — STAT_MODIFIER · OPPONENT · DECREASE (Cono de hielo, contrato §1/§2)', () => {
  const setup = (): BattleRoom =>
    battleWithCombat({
      profiles: {
        a1: skillProfile({ abilities: [ICE_CONE_FIXED] }),
        // El rival tambien necesita estado de habilidades (HU-19) para poder RECIBIR un efecto
        // temporal, aunque el no use ninguna habilidad en esta prueba.
        b1: skillProfile({ abilities: [] }),
      },
    })

  it('el debuff se adjunta al RIVAL con remainingOwnTurns = durationTurns (2)', () => {
    const room = setup()
    const plan = room.planSkill('a1', 'cmd-1', ICE_CONE_FIXED_ID, TARGET_B) as SkillReadyPlan

    expect(plan.damageBonus).toEqual({ fixed: 2, dice: [] }) // el bono instantaneo de ESTA resolucion
    expect(plan.temporalEffects).toHaveLength(1)
    expect(plan.temporalEffects[0]).toMatchObject({
      targetKey: { teamLabel: 'B', seat: 0 },
      initialRemainingOwnTurns: 2,
    })
  })

  it('reduce el Ataque efectivo del rival durante SUS 2 turnos propios y luego expira (contrato §2)', () => {
    const room = setup()
    const plan = room.planSkill('a1', 'cmd-1', ICE_CONE_FIXED_ID, TARGET_B) as SkillReadyPlan
    const outcome: SkillOutcome = {
      attackValue: 20,
      defenseValue: 5,
      effective: false,
      effect: null,
      percent: null,
      baseDamage: null,
      attackBonus: 0,
      damageBonus: null,
      resolvedTemporalEffects: [
        {
          targetKey: plan.targetEntry,
          effect: {
            sourceAbilityId: ICE_CONE_FIXED_ID,
            sourceCombatant: plan.attackerEntry,
            statistic: 'ATTACK',
            operation: 'DECREASE',
            amount: 3,
            remainingOwnTurns: 2,
          },
        },
      ],
    }
    const next = room.applySkill(plan, outcome, 'cmd-1', LATER)

    expect(combatantOf(next, 'B').statBonus('ATTACK')).toBe(-3)

    // 1er turno propio de B (decrementa 2 -> 1, sigue activo).
    const afterB1 = passTurn(next, 'b1')
    expect(combatantOf(afterB1, 'B').statBonus('ATTACK')).toBe(-3)

    // a1 pasa (no afecta a B); 2o turno propio de B (decrementa 1 -> 0, expira).
    const afterA = passTurn(afterB1, 'a1')
    const afterB2 = passTurn(afterA, 'b1')
    expect(combatantOf(afterB2, 'B').statBonus('ATTACK')).toBe(0)
  })
})

describe('BattleRoom — kind DAMAGE directo (Agonia, contrato §3)', () => {
  const setup = (): BattleRoom =>
    battleWithCombat({
      profiles: {
        a1: skillProfile({ abilities: [AGONY_FIXED] }),
        // Con estado de habilidades para poder comprobar la memoria de dano (contrato §6).
        b1: skillProfile({ abilities: [] }),
      },
    })

  it('planSkill produce un plan directDamageSkill, sin resolucion de Ataque/Defensa', () => {
    const room = setup()
    const plan = room.planSkill(
      'a1',
      'cmd-1',
      AGONY_FIXED_ID,
      TARGET_B,
    ) as SkillDirectDamageReadyPlan

    expect(plan.kind).toBe('directDamageSkill')
    expect(plan.damageBonus).toEqual({ fixed: 7, dice: [] })
  })

  it('applyDirectDamageSkill materializa el dano tal cual, publica directDamageSkillUsed y avanza el turno', () => {
    const room = setup()
    const plan = room.planSkill(
      'a1',
      'cmd-1',
      AGONY_FIXED_ID,
      TARGET_B,
    ) as SkillDirectDamageReadyPlan
    const outcome: DirectDamageOutcome = { calculatedDamage: 7 }

    const next = room.applyDirectDamageSkill(plan, outcome, 'cmd-1', LATER)
    const event = next.events.at(-1)

    expect(event?.type).toBe(BattleEventType.DirectDamageSkillUsed)
    expect(event?.payload).toMatchObject({
      damage: { calculatedDamage: 7, appliedDamage: 7 },
      targetHealth: { before: 44, after: 37 },
    })
    expect(combatantOf(next, 'B').currentHealth).toBe(37)
    // HU-19 v2 (contrato §6): cualquier fuente de dano alimenta la memoria de REFLECT_DAMAGE.
    expect(combatantOf(next, 'B').damageMemory).toEqual({ amount: 7, remainingOwnTurns: 1 })
    expect(next.battle?.currentEntry.teamLabel).toBe('B')
  })
})

describe('BattleRoom — familia HEALING (Toque de la Vida / Canto del Bosque, contrato §1/§4)', () => {
  const setup = (): BattleRoom =>
    battleWithCombat({
      teamSizes: [2, 1],
      health: { 'A#0': 20, 'A#1': 20 },
      profiles: {
        a1: skillProfile({ abilities: [LIFE_TOUCH, FOREST_SONG_FIXED], attack: null }),
        a2: skillProfile({ abilities: [] }),
      },
    })

  it('Toque de la Vida sana a UN aliado elegido, sin resolucion de Ataque/Defensa', () => {
    const room = setup()
    const plan = room.planSkill('a1', 'cmd-1', LIFE_TOUCH_ID, TARGET_A1) as SkillHealingReadyPlan

    expect(plan.kind).toBe('healingSkill')
    expect(plan.recipients).toHaveLength(1)
    expect(plan.recipients[0]?.entry).toMatchObject({ teamLabel: 'A', seat: 1 })

    const outcome: HealingOutcome = { healAmount: 2, resolvedTemporalEffects: [] }
    const next = room.applyHealingSkill(plan, outcome, 'cmd-1', LATER)
    const payload = next.events.at(-1)?.payload as HealSkillUsedPayload

    expect(payload.heal).toEqual({ amount: 2 })
    expect(payload.targetHealth).toEqual({ before: 20, after: 22 })
    expect(payload.affected).toBeUndefined() // un unico afectado: sin `affected`
    expect(combatantOf(next, 'A', 1).currentHealth).toBe(22)
  })

  it('Canto del Bosque adjunta la sanacion de grupo (temporal, contrato §2) a CADA afectado y reporta `affected` (contrato §4)', () => {
    const room = setup()
    // El wire sigue exigiendo un target valido de forma; Combat lo IGNORA a efectos de alcance.
    const plan = room.planSkill(
      'a1',
      'cmd-1',
      FOREST_SONG_FIXED_ID,
      TARGET_A1,
    ) as SkillHealingReadyPlan

    expect(plan.recipients.map((r) => r.entry.seat).sort()).toEqual([0, 1]) // a1 Y a2
    // Canto del Bosque (fixture) es PURAMENTE temporal (durationTurns:2): sin componente
    // instantaneo -- `healBonus` queda en 0, todo el monto vive en `temporalEffects`.
    expect(plan.healBonus).toEqual({ fixed: 0, dice: [] })
    expect(plan.temporalEffects).toHaveLength(2) // una plantilla POR afectado (a1 y a2)

    const outcome: HealingOutcome = {
      healAmount: 0,
      resolvedTemporalEffects: plan.temporalEffects.map((template) => ({
        targetKey: template.targetKey,
        effect: {
          sourceAbilityId: FOREST_SONG_FIXED_ID,
          sourceCombatant: template.sourceCombatant,
          statistic: 'HEALING',
          operation: 'INCREASE',
          amount: 4,
          remainingOwnTurns: template.initialRemainingOwnTurns,
        },
      })),
    }
    const next = room.applyHealingSkill(plan, outcome, 'cmd-1', LATER)
    const payload = next.events.at(-1)?.payload as HealSkillUsedPayload

    expect(payload.heal).toEqual({ amount: 0 })
    expect(payload.affected).toEqual(
      expect.arrayContaining([
        { teamLabel: 'A', seat: 0 },
        { teamLabel: 'A', seat: 1 },
      ]),
    )
    // Nadie sana TODAVIA: el efecto se adjunto DESPUES de completeTurn (esta transicion no lo
    // alcanza), ni siquiera al propio actor (a1) pese a incluirse en su propio grupo.
    expect(combatantOf(next, 'A', 0).currentHealth).toBe(20)
    expect(combatantOf(next, 'A', 1).currentHealth).toBe(20)
    // Cada afectado lleva su PROPIA copia del efecto temporal, con remainingOwnTurns = durationTurns.
    expect(combatantOf(next, 'A', 0).activeSkillEffects).toEqual([
      expect.objectContaining({ remainingOwnTurns: 2 }),
    ])
    expect(combatantOf(next, 'A', 1).activeSkillEffects).toEqual([
      expect.objectContaining({ remainingOwnTurns: 2 }),
    ])

    // Orden de turno [a1, b1, a2]: tras la accion de a1 le toca a b1, luego a a2.
    // Cuando a2 cierra SU propio turno, su tick de sanacion aplica de forma independiente.
    const afterB = passTurn(next, 'b1')
    const afterA2 = passTurn(afterB, 'a2')

    expect(combatantOf(afterA2, 'A', 1).currentHealth).toBe(24) // 20 + 4, a2 ya cerro su turno
    expect(combatantOf(afterA2, 'A', 0).currentHealth).toBe(20) // a1 aun no cerro el SUYO

    // El turno vuelve a a1: al cerrarlo, su PROPIO tick tambien aplica.
    const afterA1 = passTurn(afterA2, 'a1')

    expect(combatantOf(afterA1, 'A', 0).currentHealth).toBe(24)
  })
})

describe('BattleRoom — kind REFLECT_DAMAGE (Pare de fuego, contrato §6)', () => {
  const setup = (): BattleRoom =>
    battleWithCombat({
      firstTeam: 'B',
      profiles: { a1: skillProfile({ abilities: [FIRE_WARD] }) },
    })

  it('sin dano recibido en el turno propio anterior, el reflejo aporta 0 (no es un rechazo)', () => {
    const room = setup()
    // b1 pasa sin hacer dano: a1 nunca recibio nada.
    const afterB = passTurn(room, 'b1')
    const plan = afterB.planSkill('a1', 'cmd-1', FIRE_WARD_ID, TARGET_B) as SkillReadyPlan

    expect(plan.damageBonus).toEqual({ fixed: 0, dice: [] })
    expect(plan.attackBonus).toEqual({ fixed: 1, dice: [] })
  })

  it('con dano recibido en su turno propio anterior, el reflejo se SUMA al bono de Dano', () => {
    const room = setup()
    // b1 golpea de verdad a a1 (turno de B): 44 -> 36, memoria de dano = 8.
    const hitPlan = room.planBasicAttack('b1', 'hit', TARGET_A)

    if (hitPlan.kind !== 'ready') {
      throw new Error('se esperaba un plan de ataque listo')
    }

    const afterHit = room.applyBasicAttack(
      hitPlan,
      {
        attackValue: 20,
        defenseValue: 5,
        effective: true,
        effect: 'DAMAGE',
        percent: 100,
        baseDamage: 8,
      },
      'hit',
      LATER,
    )

    expect(combatantOf(afterHit, 'A').damageMemory).toEqual({ amount: 8, remainingOwnTurns: 1 })

    // Ahora es el turno propio de a1: usa Pare de fuego -- el reflejo (100% de 8) se suma al bono.
    const plan = afterHit.planSkill('a1', 'cmd-1', FIRE_WARD_ID, TARGET_B) as SkillReadyPlan

    expect(plan.damageBonus).toEqual({ fixed: 8, dice: [] })
  })
})
