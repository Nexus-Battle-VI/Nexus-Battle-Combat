import {
  evaluateBattleUtility,
  UTILITY_VERSION_PVE_V1,
  type BattleUtilityActorVitals,
  type BattleUtilityEnemyVitals,
} from '../../src/domain/policies/BattleUtilityEvaluator'
import { InvalidUtilityStateError } from '../../src/domain/errors/MctsErrors'

const actor = (overrides: Partial<BattleUtilityActorVitals> = {}): BattleUtilityActorVitals => ({
  currentHealth: 44,
  maxHealth: 44,
  power: { current: 10, max: 10 },
  ...overrides,
})

const enemy = (overrides: Partial<BattleUtilityEnemyVitals> = {}): BattleUtilityEnemyVitals => ({
  currentHealth: 44,
  maxHealth: 44,
  ...overrides,
})

describe('BattleUtilityEvaluator (pve-utility-v1, EN-036.1)', () => {
  it('U-01: victoria con Vida/Poder llenos y enemigo muerto da utilidad maxima (1)', () => {
    const result = evaluateBattleUtility('WIN', actor(), [enemy({ currentHealth: 0 })])

    expect(result.utilityVersion).toBe(UTILITY_VERSION_PVE_V1)
    expect(result.components).toEqual({ win: 1, health: 1, power: 1, damage: 1 })
    expect(result.utility).toBeCloseTo(1, 10)
  })

  it('U-02: derrota con Vida/Poder a cero y enemigo ileso da utilidad minima (0)', () => {
    const result = evaluateBattleUtility(
      'LOSS',
      actor({ currentHealth: 0, power: { current: 0, max: 10 } }),
      [enemy()],
    )

    expect(result.components).toEqual({ win: 0, health: 0, power: 0, damage: 0 })
    expect(result.utility).toBeCloseTo(0, 10)
  })

  it('U-03: estado no terminal usa W = 0.5 (ni favorece ni penaliza)', () => {
    const result = evaluateBattleUtility('NON_TERMINAL', actor(), [enemy()])

    expect(result.components.win).toBe(0.5)
  })

  it('U-04: formula exacta pve-utility-v1 (0.60W + 0.15H + 0.10P + 0.15D)', () => {
    const result = evaluateBattleUtility(
      'NON_TERMINAL',
      actor({ currentHealth: 22, maxHealth: 44, power: { current: 5, max: 10 } }),
      [enemy({ currentHealth: 11, maxHealth: 44 })],
    )

    // W=0.5, H=0.5, P=0.5, D=1-11/44=0.75
    const expected = 0.6 * 0.5 + 0.15 * 0.5 + 0.1 * 0.5 + 0.15 * 0.75
    expect(result.utility).toBeCloseTo(expected, 10)
  })

  it('U-05: maxHealth invalido (<=0) falla explicitamente, nunca oculta el dato', () => {
    expect(() => evaluateBattleUtility('WIN', actor({ maxHealth: 0 }), [enemy()])).toThrow(
      InvalidUtilityStateError,
    )
  })

  it('U-06: Vida/Poder no finitos fallan explicitamente', () => {
    expect(() =>
      evaluateBattleUtility('WIN', actor({ currentHealth: Number.NaN }), [enemy()]),
    ).toThrow(InvalidUtilityStateError)
  })

  it('U-07: actor sin sistema de Poder (power: null) usa el valor neutral P = 1 (decision v1)', () => {
    const result = evaluateBattleUtility('NON_TERMINAL', actor({ power: null }), [enemy()])

    expect(result.components.power).toBe(1)
  })

  it('U-08: maxPower invalido (<=0) con power no nulo falla explicitamente', () => {
    expect(() =>
      evaluateBattleUtility('WIN', actor({ power: { current: 1, max: 0 } }), [enemy()]),
    ).toThrow(InvalidUtilityStateError)
  })

  it('U-09: sin enemigos vivos (lista vacia o todos a 0) el progreso de dano D es maximo (1)', () => {
    const vacia = evaluateBattleUtility('WIN', actor(), [])
    const todosMuertos = evaluateBattleUtility('WIN', actor(), [
      enemy({ currentHealth: 0 }),
      enemy({ currentHealth: 0, maxHealth: 20 }),
    ])

    expect(vacia.components.damage).toBe(1)
    expect(todosMuertos.components.damage).toBe(1)
  })

  it('U-10: D promedia por Vida total del equipo rival, no por enemigo', () => {
    const result = evaluateBattleUtility('NON_TERMINAL', actor(), [
      enemy({ currentHealth: 10, maxHealth: 20 }), // vivo, mitad de Vida
      enemy({ currentHealth: 0, maxHealth: 20 }), // muerto: no cuenta en la suma
    ])

    // Solo el enemigo vivo cuenta: D = 1 - 10/20 = 0.5
    expect(result.components.damage).toBeCloseTo(0.5, 10)
  })

  it('cada componente y el total quedan siempre clamped a [0,1]', () => {
    const result = evaluateBattleUtility(
      'WIN',
      actor({ currentHealth: 44, maxHealth: 44, power: { current: 10, max: 10 } }),
      [enemy({ currentHealth: 0 })],
    )

    for (const value of Object.values(result.components)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(result.utility).toBeGreaterThanOrEqual(0)
    expect(result.utility).toBeLessThanOrEqual(1)
  })

  it('un enemigo vivo con maxHealth invalido falla explicitamente', () => {
    expect(() =>
      evaluateBattleUtility('WIN', actor(), [enemy({ currentHealth: 5, maxHealth: 0 })]),
    ).toThrow(InvalidUtilityStateError)
  })
})
