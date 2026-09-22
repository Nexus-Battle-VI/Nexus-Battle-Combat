import { UnsupportedCombatProfileError } from '../../src/domain/errors/BattleErrors'
import { DomainError } from '../../src/domain/errors/DomainError'
import {
  applyDamage,
  assertSupportedDamage,
  calculateDamage,
  MAX_EFFECT_PERCENT,
} from '../../src/domain/policies/BasicAttackDamagePolicy'

/**
 * Del Dano a la Vida (HU-18). El redondeo es `floor`: aclaracion formal registrada en
 * Management #62 (2026-09-21); el documento oficial no lo definia.
 */
describe('calculateDamage — floor(dano base x porcentaje / 100)', () => {
  it.each([
    // [dano base, porcentaje, esperado, motivo]
    [5, 137, 6, 'critico: 5 x 1,37 = 6,85'],
    [3, 80, 2, 'evaden: 3 x 0,80 = 2,4'],
    [4, 60, 2, 'resisten: 4 x 0,60 = 2,4'],
    [3, 20, 0, 'escapan: 3 x 0,20 = 0,6'],
    [5, 20, 1, 'escapan: 5 x 0,20 = 1 exacto'],
    [6, 100, 6, 'causar dano: 100 %'],
    [6, 0, 0, 'no causa dano: 0 %'],
    [1, 120, 1, 'critico minimo sobre 1: 1,2'],
    [1, 180, 1, 'critico maximo sobre 1: 1,8'],
    [8, 180, 14, 'critico maximo sobre 8: 14,4'],
    [0, 137, 0, 'dano base 0'],
  ])('%i x %i %% = %i (%s)', (base, percent, expected) => {
    expect(calculateDamage(base, percent)).toBe(expected)
  })

  it('nunca redondea hacia arriba: 1 punto menos que el entero siguiente sigue en el inferior', () => {
    // 7 x 99 % = 6,93 -> 6 (round o ceil darian 7).
    expect(calculateDamage(7, 99)).toBe(6)
  })

  it('coincide con la division entera para TODOS los pares (base 0..12, porcentaje 0..180)', () => {
    for (let base = 0; base <= 12; base += 1) {
      for (let percent = 0; percent <= MAX_EFFECT_PERCENT; percent += 1) {
        expect(calculateDamage(base, percent)).toBe(Math.trunc((base * percent) / 100))
      }
    }
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rechaza un dano base %p', (base) => {
    expect(() => calculateDamage(base, 100)).toThrow(DomainError)
  })

  it.each([-1, 181, 12.5, Number.NaN])('rechaza un porcentaje %p', (percent) => {
    expect(() => calculateDamage(5, percent)).toThrow(DomainError)
  })
})

describe('applyDamage — la Vida nunca baja de 0', () => {
  it('descuenta el dano calculado', () => {
    expect(applyDamage(40, 6)).toEqual({
      calculatedDamage: 6,
      appliedDamage: 6,
      healthBefore: 40,
      healthAfter: 34,
    })
  })

  it('un dano de 0 no cambia la Vida', () => {
    expect(applyDamage(40, 0)).toMatchObject({ appliedDamage: 0, healthAfter: 40 })
  })

  it('overkill: el dano aplicado es la Vida restante, no el calculado (que se conserva por trazabilidad)', () => {
    expect(applyDamage(3, 14)).toEqual({
      calculatedDamage: 14,
      appliedDamage: 3,
      healthBefore: 3,
      healthAfter: 0,
    })
  })

  it('dano exactamente igual a la Vida: queda en 0', () => {
    expect(applyDamage(5, 5)).toMatchObject({ appliedDamage: 5, healthAfter: 0 })
  })

  it('una Vida ya en 0 no cambia', () => {
    expect(applyDamage(0, 4)).toMatchObject({ appliedDamage: 0, healthAfter: 0 })
  })

  it.each([
    [-1, 2],
    [10.5, 2],
    [10, -1],
    [10, 2.5],
  ])('rechaza valores invalidos (Vida %p, dano %p)', (health, damage) => {
    expect(() => applyDamage(health, damage)).toThrow(DomainError)
  })
})

describe('assertSupportedDamage — se decide ANTES de consumir un solo sorteo', () => {
  it('DICE valido', () => {
    expect(assertSupportedDamage({ mode: 'DICE', count: 1, sides: 6 })).toEqual({
      mode: 'DICE',
      count: 1,
      sides: 6,
    })
  })

  it('FIXED valido (incluido 0)', () => {
    expect(assertSupportedDamage({ mode: 'FIXED', amount: 3 })).toEqual({
      mode: 'FIXED',
      amount: 3,
    })
    expect(assertSupportedDamage({ mode: 'FIXED', amount: 0 })).toEqual({
      mode: 'FIXED',
      amount: 0,
    })
  })

  it('PERCENTAGE no esta soportado: ninguna fuente formal define su base', () => {
    expect(() => assertSupportedDamage({ mode: 'PERCENTAGE', basisPoints: 300 })).toThrow(
      UnsupportedCombatProfileError,
    )
  })

  it('sin Dano (sanadores) no esta soportado', () => {
    expect(() => assertSupportedDamage(null)).toThrow(UnsupportedCombatProfileError)
  })

  it.each([
    { mode: 'FIXED', amount: -1 },
    { mode: 'FIXED', amount: 1.5 },
    { mode: 'DICE', count: 0, sides: 6 },
    { mode: 'DICE', count: 1, sides: 1 },
    { mode: 'DICE', count: 1.5, sides: 6 },
    { mode: 'DICE', count: 1, sides: 6.5 },
  ] as const)('un Dano invalido (%j) se rechaza como perfil no soportado', (magnitude) => {
    expect(() => assertSupportedDamage(magnitude)).toThrow(UnsupportedCombatProfileError)
  })
})
