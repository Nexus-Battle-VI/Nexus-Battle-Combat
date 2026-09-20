import {
  InsufficientNoDamageProbabilityError,
  InvalidProbabilityModifierError,
} from '../../src/domain/errors/RandomEffectErrors'
import { baseEffectTableFor } from '../../src/domain/random-effects/BaseEffectProfiles'
import { EffectControlTable } from '../../src/domain/random-effects/EffectControlTable'
import { ProbabilityModifier } from '../../src/domain/random-effects/ProbabilityModifier'
import {
  RANDOM_EFFECT_ORDER,
  RandomEffectType,
} from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'

const D = RandomEffectType.Damage
const C = RandomEffectType.CriticalDamage
const E = RandomEffectType.Evade
const R = RandomEffectType.Resist
const S = RandomEffectType.Escape
const N = RandomEffectType.NoDamage

const armas = (): EffectControlTable => baseEffectTableFor(HeroSubtype.GuerreroArmas)

const rowsOf = (table: EffectControlTable): number[] =>
  RANDOM_EFFECT_ORDER.map((effect) => table.rowsOf(effect))

describe('ProbabilityModifier', () => {
  describe('construccion', () => {
    it('ofRows guarda el incremento en filas enteras', () => {
      const modifier = ProbabilityModifier.ofRows(C, 480)

      expect(modifier.effect).toBe(C)
      expect(modifier.rows).toBe(480)
    })

    it.each([
      [100, 80],
      [600, 480],
      [300, 240],
      [5, 4],
      [0, 0],
      [10_000, 8000],
    ])('ofBasisPoints(%i pb) equivale exactamente a %i filas', (basisPoints, expectedRows) => {
      expect(ProbabilityModifier.ofBasisPoints(C, basisPoints).rows).toBe(expectedRows)
    })

    it.each([1, 2, 3, 4, 7, 301, 599])(
      'ofBasisPoints(%i pb) se rechaza: no equivale a un numero exacto de filas (sin redondeo)',
      (basisPoints) => {
        expect(() => ProbabilityModifier.ofBasisPoints(C, basisPoints)).toThrow(
          InvalidProbabilityModifierError,
        )
        expect(() => ProbabilityModifier.ofBasisPoints(C, basisPoints)).toThrow(/no se redondea/)
      },
    )

    it.each([-1, -80, 1.5, 0.1 + 0.2, Number.NaN, Number.POSITIVE_INFINITY, '6', null, undefined])(
      'rechaza el incremento invalido %p (decrementos y cantidades no enteras no estan definidos)',
      (bad) => {
        expect(() => ProbabilityModifier.ofRows(C, bad)).toThrow(InvalidProbabilityModifierError)
        expect(() => ProbabilityModifier.ofBasisPoints(C, bad)).toThrow(
          InvalidProbabilityModifierError,
        )
      },
    )

    it('no permite aumentar "no causar dano": no hay regla de compensacion para el', () => {
      expect(() => ProbabilityModifier.ofRows(N, 80)).toThrow(InvalidProbabilityModifierError)
      expect(() => ProbabilityModifier.ofBasisPoints(N, 100)).toThrow(/no causar dano/)
    })

    it.each(['STUN', 'damage', '', null, undefined, 42])(
      'rechaza el efecto desconocido %p',
      (effect) => {
        expect(() => ProbabilityModifier.ofRows(effect, 80)).toThrow(
          InvalidProbabilityModifierError,
        )
      },
    )
  })

  describe('aplicacion sobre la tabla: todo incremento se resta de "no causar dano"', () => {
    it('+6 % de critico: critico 400 -> 880 y "no causar dano" 2400 -> 1920, el resto intacto', () => {
      const result = armas().withModifiers([ProbabilityModifier.ofBasisPoints(C, 600)])

      expect(rowsOf(result)).toEqual([4800, 880, 240, 0, 160, 1920])
    })

    it('un incremento de otro efecto tambien se compensa en "no causar dano" (+2 % de escape)', () => {
      const result = armas().withModifiers([ProbabilityModifier.ofBasisPoints(S, 200)])

      expect(rowsOf(result)).toEqual([4800, 400, 240, 0, 320, 2240])
    })

    it('un incremento de "resisten" (que parte de 0 filas) crea el rango', () => {
      const result = armas().withModifiers([ProbabilityModifier.ofRows(R, 80)])

      expect(rowsOf(result)).toEqual([4800, 400, 240, 80, 160, 2320])
      expect(result.ranges.some((range) => range.effect === R)).toBe(true)
    })

    it('modificador de 0 filas: la misma tabla', () => {
      const base = armas()
      const result = base.withModifiers([ProbabilityModifier.ofRows(C, 0)])

      expect(rowsOf(result)).toEqual(rowsOf(base))
      expect(result.ranges).toEqual(base.ranges)
    })

    it('sin modificadores: la misma tabla', () => {
      const base = armas()

      expect(base.withModifiers([]).ranges).toEqual(base.ranges)
    })

    it('varios incrementos son aditivos y su orden no importa', () => {
      const crit = ProbabilityModifier.ofBasisPoints(C, 600)
      const escape = ProbabilityModifier.ofBasisPoints(S, 200)
      const evade = ProbabilityModifier.ofBasisPoints(E, 100)

      const forward = armas().withModifiers([crit, escape, evade])
      const backward = armas().withModifiers([evade, escape, crit])

      expect(rowsOf(forward)).toEqual([4800, 880, 320, 0, 320, 1680])
      expect(rowsOf(backward)).toEqual(rowsOf(forward))
      expect(forward.ranges).toEqual(backward.ranges)
    })

    it('el total sigue siendo 8000 tras cualquier modificacion valida', () => {
      const result = armas().withModifiers([ProbabilityModifier.ofBasisPoints(C, 600)])

      expect(rowsOf(result).reduce((sum, value) => sum + value, 0)).toBe(8000)
    })

    it('la tabla original nunca cambia', () => {
      const base = armas()
      const before = rowsOf(base)

      base.withModifiers([ProbabilityModifier.ofBasisPoints(C, 600)])

      expect(rowsOf(base)).toEqual(before)
    })

    it('se puede consumir TODO "no causar dano": queda en 0 filas y sin rango', () => {
      const result = armas().withModifiers([ProbabilityModifier.ofRows(C, 2400)])

      expect(rowsOf(result)).toEqual([4800, 2800, 240, 0, 160, 0])
      expect(result.ranges.some((range) => range.effect === N)).toBe(false)
      expect(result.ranges[result.ranges.length - 1]?.lastRow).toBe(8000)
    })
  })

  describe('entradas imposibles fallan de forma explicita', () => {
    it('un incremento mayor que "no causar dano" disponible produce un error de dominio', () => {
      expect(() => armas().withModifiers([ProbabilityModifier.ofRows(C, 2401)])).toThrow(
        InsufficientNoDamageProbabilityError,
      )
      expect(() => armas().withModifiers([ProbabilityModifier.ofRows(C, 2401)])).toThrow(
        /necesita 2401 filas .* solo hay 2400/,
      )
    })

    it('el ejemplo del enunciado: "no causar dano" = 3 % y modificador +6 % -> error', () => {
      // 3 % = 240 filas de "no causar dano"; +6 % = 480 filas.
      const scarce = EffectControlTable.fromRowCounts({
        [D]: 7760,
        [C]: 0,
        [E]: 0,
        [R]: 0,
        [S]: 0,
        [N]: 240,
      })

      expect(() => scarce.withModifiers([ProbabilityModifier.ofBasisPoints(C, 600)])).toThrow(
        InsufficientNoDamageProbabilityError,
      )
    })

    it('varios modificadores que JUNTOS superan lo disponible tambien fallan', () => {
      expect(() =>
        armas().withModifiers([
          ProbabilityModifier.ofRows(C, 1500),
          ProbabilityModifier.ofRows(S, 901),
        ]),
      ).toThrow(InsufficientNoDamageProbabilityError)
    })

    it('un fallo no deja una tabla parcialmente modificada', () => {
      const base = armas()

      expect(() => base.withModifiers([ProbabilityModifier.ofRows(C, 99_999)])).toThrow()
      expect(rowsOf(base)).toEqual([4800, 400, 240, 0, 160, 2400])
    })
  })
})
