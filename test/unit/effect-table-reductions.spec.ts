import { baseEffectTableFor } from '../../src/domain/random-effects/BaseEffectProfiles'
import {
  EFFECT_TABLE_ROWS,
  type EffectControlTable,
} from '../../src/domain/random-effects/EffectControlTable'
import { ProbabilityModifier } from '../../src/domain/random-effects/ProbabilityModifier'
import {
  RANDOM_EFFECT_ORDER,
  RandomEffectType,
} from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'

const D = RandomEffectType.Damage
const C = RandomEffectType.CriticalDamage
const N = RandomEffectType.NoDamage

const rowsOf = (table: EffectControlTable): Record<string, number> =>
  Object.fromEntries(RANDOM_EFFECT_ORDER.map((effect) => [effect, table.rowsOf(effect)]))

const total = (table: EffectControlTable): number =>
  RANDOM_EFFECT_ORDER.reduce((sum, effect) => sum + table.rowsOf(effect), 0)

const reduction = (effect: RandomEffectType, basisPoints: number): ProbabilityModifier =>
  ProbabilityModifier.ofBasisPoints(effect, basisPoints)

/**
 * HU-25 / HU-20: `-2 % de critico al ataque del oponente` (Baculo de
 * Permafrost, Tabla 9). Es el sentido inverso de la regla de la Tabla 23: lo que
 * un efecto pierde vuelve a «no causar dano», el efecto residual.
 */
describe('EffectControlTable.withReductions', () => {
  const armas = baseEffectTableFor(HeroSubtype.GuerreroArmas)

  it('-2 % de critico: el critico pasa de 400 a 240 filas y «no causar dano» de 2400 a 2560', () => {
    const reduced = armas.withReductions([reduction(C, 200)])

    expect(reduced.rowsOf(C)).toBe(240)
    expect(reduced.rowsOf(N)).toBe(2560)
    expect(reduced.rowsOf(D)).toBe(armas.rowsOf(D))
  })

  it('la suma sigue siendo exactamente 8000 filas', () => {
    expect(total(armas.withReductions([reduction(C, 200)]))).toBe(EFFECT_TABLE_ROWS)
  })

  it('el resto de efectos no cambia', () => {
    const reduced = armas.withReductions([reduction(C, 200)])

    for (const effect of RANDOM_EFFECT_ORDER) {
      if (effect !== C && effect !== N) {
        expect(reduced.rowsOf(effect)).toBe(armas.rowsOf(effect))
      }
    }
  })

  it('devuelve una tabla NUEVA y no modifica la original', () => {
    const before = rowsOf(armas)
    const reduced = armas.withReductions([reduction(C, 200)])

    expect(reduced).not.toBe(armas)
    expect(rowsOf(armas)).toEqual(before)
  })

  it('sin reducciones devuelve una tabla equivalente', () => {
    expect(armas.withReductions([]).ranges).toEqual(armas.ranges)
  })

  describe('una probabilidad no puede ser negativa: se acota en 0 filas', () => {
    it('reducir mas de lo que hay deja el critico en 0 y devuelve solo lo que tenia', () => {
      const reduced = armas.withReductions([reduction(C, 1000)])

      expect(reduced.rowsOf(C)).toBe(0)
      expect(reduced.rowsOf(N)).toBe(2400 + 400)
      expect(total(reduced)).toBe(EFFECT_TABLE_ROWS)
    })

    it('un efecto que ya esta en 0 no cambia la tabla (Tanque: critico 0 %)', () => {
      const tanque = baseEffectTableFor(HeroSubtype.GuerreroTanque)
      const reduced = tanque.withReductions([reduction(C, 200)])

      expect(rowsOf(reduced)).toEqual(rowsOf(tanque))
    })
  })

  describe('varias reducciones', () => {
    it('se suman: -2 % y -1 % equivalen a -3 %', () => {
      const separate = armas.withReductions([reduction(C, 200), reduction(C, 100)])
      const single = armas.withReductions([reduction(C, 300)])

      expect(rowsOf(separate)).toEqual(rowsOf(single))
      expect(separate.rowsOf(C)).toBe(400 - 240)
    })

    it('no dependen del orden', () => {
      const one = armas.withReductions([reduction(C, 200), reduction(D, 100)])
      const other = armas.withReductions([reduction(D, 100), reduction(C, 200)])

      expect(rowsOf(one)).toEqual(rowsOf(other))
    })

    it('varias reducciones que juntas superan las filas del efecto se acotan una sola vez', () => {
      const reduced = armas.withReductions([reduction(C, 300), reduction(C, 300)])

      expect(reduced.rowsOf(C)).toBe(0)
      expect(reduced.rowsOf(N)).toBe(2400 + 400)
    })

    it('pueden reducir efectos distintos a la vez', () => {
      const reduced = armas.withReductions([
        reduction(C, 200),
        reduction(RandomEffectType.Evade, 100),
      ])

      expect(reduced.rowsOf(C)).toBe(240)
      expect(reduced.rowsOf(RandomEffectType.Evade)).toBe(240 - 80)
      expect(reduced.rowsOf(N)).toBe(2400 + 160 + 80)
    })
  })

  describe('combinada con incrementos propios (orden: primero incrementos, luego reducciones)', () => {
    it('+3 % propio y -2 % del oponente = +1 % neto', () => {
      const net = armas.withModifiers([reduction(C, 300)]).withReductions([reduction(C, 200)])

      expect(net.rowsOf(C)).toBe(400 + 80)
      expect(net.rowsOf(N)).toBe(2400 - 80)
    })

    it('+1 % propio y -2 % del oponente sobre un critico de 0 % se acota en 0 (no queda negativo)', () => {
      const tanque = baseEffectTableFor(HeroSubtype.GuerreroTanque)
      const net = tanque.withModifiers([reduction(C, 100)]).withReductions([reduction(C, 200)])

      expect(net.rowsOf(C)).toBe(0)
      expect(net.rowsOf(N)).toBe(tanque.rowsOf(N))
    })

    it('el resultado equivale a sumar el neto y acotarlo en 0', () => {
      for (const [increaseBp, reductionBp] of [
        [0, 0],
        [100, 200],
        [300, 200],
        [600, 100],
        [0, 500],
      ] as const) {
        const composed = armas
          .withModifiers([reduction(C, increaseBp)])
          .withReductions([reduction(C, reductionBp)])
        const netRows = Math.max(
          0,
          400 + (increaseBp * 8000) / 10_000 - (reductionBp * 8000) / 10_000,
        )

        expect(composed.rowsOf(C)).toBe(netRows)
        expect(total(composed)).toBe(EFFECT_TABLE_ROWS)
      }
    })
  })
})
