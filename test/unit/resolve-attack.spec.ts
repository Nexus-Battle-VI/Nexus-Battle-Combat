import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import { ResolveAttack } from '../../src/application/use-cases/ResolveAttack'
import { ResolveRandomEffect } from '../../src/application/use-cases/ResolveRandomEffect'
import { DomainError } from '../../src/domain/errors/DomainError'
import { baseEffectTableFor } from '../../src/domain/random-effects/BaseEffectProfiles'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'

/**
 * Secuencia de prueba DETERMINISTA: devuelve los indices dados en orden y cuenta
 * las llamadas. No hay generador real: HU-20 se prueba sin HU-24.
 */
class ScriptedSequence implements RandomSequencePort {
  calls = 0

  constructor(private readonly indices: readonly number[]) {}

  nextIndex(): RandomIndex {
    const value = this.indices[this.calls]
    this.calls += 1

    if (value === undefined) {
      throw new Error('La secuencia de prueba se quedo sin indices.')
    }

    return RandomIndex.create(value)
  }
}

/** Secuencia que siempre devuelve el mismo indice y cuenta las llamadas. */
class ConstantSequence implements RandomSequencePort {
  calls = 0

  constructor(private readonly index: number) {}

  nextIndex(): RandomIndex {
    this.calls += 1

    return RandomIndex.create(this.index)
  }
}

const armas = baseEffectTableFor(HeroSubtype.GuerreroArmas)
const D = RandomEffectType.Damage
const C = RandomEffectType.CriticalDamage
const E = RandomEffectType.Evade
const N = RandomEffectType.NoDamage

const d6 = { count: 1, sides: 6 } as const

describe('ResolveAttack (HU-20)', () => {
  const useCase = new ResolveAttack()

  describe('CA-01 y CA-05: el Ataque supera la Defensa -> golpe efectivo y se delega el efecto', () => {
    it('sin dado: compara, y el efecto sale del UNICO indice consumido', () => {
      const sequence = new ScriptedSequence([4801])

      const result = useCase.execute({
        attack: { base: 13, dice: null },
        defenseValue: 11,
        table: armas,
        sequence,
      })

      expect(result).toEqual({
        attackBase: 13,
        attackRoll: 0,
        attackValue: 13,
        defenseValue: 11,
        effective: true,
        effect: {
          effect: C,
          magnitude: { kind: 'PERCENT_RANGE', minPercent: 120, maxPercent: 180 },
          percent: 120,
        },
      })
      expect(sequence.calls).toBe(1)
    })

    it('con dado: el Ataque es base + cara; la cara sale del primer indice y el efecto del segundo', () => {
      // Indice 2648 con un d6 -> cara 2. Ataque 10 + 2 = 12 > 11 -> efectivo.
      // Indice 3529 -> fila 3529 de Armas -> DAMAGE (1-4800), 100 %.
      const sequence = new ScriptedSequence([2648, 3529])

      const result = useCase.execute({
        attack: { base: 10, dice: d6 },
        defenseValue: 11,
        table: armas,
        sequence,
      })

      expect(result).toEqual({
        attackBase: 10,
        attackRoll: 2,
        attackValue: 12,
        defenseValue: 11,
        effective: true,
        effect: { effect: D, magnitude: { kind: 'FIXED_PERCENT', percent: 100 }, percent: 100 },
      })
      expect(sequence.calls).toBe(2)
    })

    it.each([
      [1500, D],
      [4801, C],
      [5300, E],
      [7000, N],
    ])(
      'un golpe efectivo con el indice de efecto %i resuelve %s segun la tabla',
      (index, effect) => {
        const result = useCase.execute({
          attack: { base: 20, dice: null },
          defenseValue: 10,
          table: armas,
          sequence: new ScriptedSequence([index]),
        })

        expect(result.effective).toBe(true)
        expect(result.effect?.effect).toBe(effect)
      },
    )

    it('el efecto que devuelve es exactamente el de ResolveRandomEffect con la misma tabla e indice', () => {
      const expected = new ResolveRandomEffect().execute({
        sequence: new ScriptedSequence([5000]),
        table: armas,
      })
      const result = useCase.execute({
        attack: { base: 20, dice: null },
        defenseValue: 10,
        table: armas,
        sequence: new ScriptedSequence([5000]),
      })

      expect(result.effect).toEqual(expected)
    })
  })

  describe('CA-04: el Ataque no supera la Defensa -> el golpe no produce ningun efecto', () => {
    it('sin dado: no consume NINGUN indice y no hay efecto', () => {
      const sequence = new ScriptedSequence([])

      const result = useCase.execute({
        attack: { base: 10, dice: null },
        defenseValue: 11,
        table: armas,
        sequence,
      })

      expect(result).toEqual({
        attackBase: 10,
        attackRoll: 0,
        attackValue: 10,
        defenseValue: 11,
        effective: false,
        effect: null,
      })
      expect(sequence.calls).toBe(0)
    })

    it('con dado: consume SOLO el indice del dado, ninguno para el efecto', () => {
      // Indice 1 con un d6 -> cara 1. Ataque 10 + 1 = 11 = Defensa -> NO supera.
      const sequence = new ScriptedSequence([1])

      const result = useCase.execute({
        attack: { base: 10, dice: d6 },
        defenseValue: 11,
        table: armas,
        sequence,
      })

      expect(result.effective).toBe(false)
      expect(result.effect).toBeNull()
      expect(result.attackValue).toBe(11)
      expect(sequence.calls).toBe(1)
    })

    it('no consulta la tabla ni invoca ResolveRandomEffect', () => {
      const resolveRandomEffect = new ResolveRandomEffect()
      const execute = jest.spyOn(resolveRandomEffect, 'execute')
      const resolve = jest.spyOn(armas, 'resolve')

      new ResolveAttack(resolveRandomEffect).execute({
        attack: { base: 5, dice: null },
        defenseValue: 11,
        table: armas,
        sequence: new ScriptedSequence([]),
      })

      expect(execute).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
      resolve.mockRestore()
    })
  })

  describe('frontera: Ataque = Defensa NO es efectivo; Ataque = Defensa + 1 si', () => {
    it.each([
      [10, 11, false, 0],
      [11, 11, false, 0],
      [12, 11, true, 1],
      [0, 0, false, 0],
      [1, 0, true, 1],
    ])(
      'Ataque %i contra Defensa %i: efectivo=%s, indices consumidos=%i',
      (attack, defense, effective, calls) => {
        const sequence = new ConstantSequence(1500)

        const result = useCase.execute({
          attack: { base: attack, dice: null },
          defenseValue: defense,
          table: armas,
          sequence,
        })

        expect(result.effective).toBe(effective)
        expect(sequence.calls).toBe(calls)
      },
    )

    it('con dado, el valor comparado es base + cara y la igualdad tampoco supera', () => {
      // base 10, indice 1334 -> cara 1 (el d6 reparte 1334 filas a la cara 1): 11 vs 11.
      const sequence = new ScriptedSequence([1334])

      expect(
        useCase.execute({
          attack: { base: 10, dice: d6 },
          defenseValue: 11,
          table: armas,
          sequence,
        }).effective,
      ).toBe(false)
    })
  })

  describe('barrido: la regla vale para cualquier par de valores', () => {
    it('efectivo <=> Ataque > Defensa, y solo el golpe efectivo consume el indice del efecto', () => {
      for (let attack = 0; attack <= 20; attack += 1) {
        for (let defense = 0; defense <= 20; defense += 1) {
          const sequence = new ConstantSequence(1500)

          const result = useCase.execute({
            attack: { base: attack, dice: null },
            defenseValue: defense,
            table: armas,
            sequence,
          })

          expect({ attack, defense, effective: result.effective }).toEqual({
            attack,
            defense,
            effective: attack > defense,
          })
          expect(sequence.calls).toBe(attack > defense ? 1 : 0)
          expect(result.effect === null).toBe(!(attack > defense))
        }
      }
    })
  })

  describe('dado de Ataque', () => {
    it('cada cara posible del d6 se suma a la base', () => {
      // Indices del interior de cada tramo: el d6 da 1, 2, 3, 4, 5 y 6. Las fronteras
      // exactas de cada cara se prueban en `attack-profile.spec.ts`.
      for (const [index, face] of [
        [1, 1],
        [2000, 2],
        [3000, 3],
        [5000, 4],
        [6000, 5],
        [7500, 6],
      ] as const) {
        const result = useCase.execute({
          attack: { base: 10, dice: d6 },
          defenseValue: 99,
          table: armas,
          sequence: new ScriptedSequence([index]),
        })

        expect(result.attackRoll).toBe(face)
        expect(result.attackValue).toBe(10 + face)
      }
    })

    it('dos dados consumen dos indices y suman sus caras', () => {
      const sequence = new ScriptedSequence([1, 8000]) // d6: cara 1 y cara 6

      const result = useCase.execute({
        attack: { base: 5, dice: { count: 2, sides: 6 } },
        defenseValue: 99,
        table: armas,
        sequence,
      })

      expect(result.attackRoll).toBe(7)
      expect(result.attackValue).toBe(12)
      expect(sequence.calls).toBe(2)
    })

    it('un golpe efectivo con dado consume dice.count + 1 indices; uno no efectivo, dice.count', () => {
      const effective = new ConstantSequence(8000) // cara 6
      const missed = new ConstantSequence(1) // cara 1

      useCase.execute({
        attack: { base: 10, dice: d6 },
        defenseValue: 11,
        table: armas,
        sequence: effective,
      })
      useCase.execute({
        attack: { base: 10, dice: d6 },
        defenseValue: 11,
        table: armas,
        sequence: missed,
      })

      expect(effective.calls).toBe(2)
      expect(missed.calls).toBe(1)
    })
  })

  describe('una secuencia de golpes avanza solo lo que consume cada uno', () => {
    it('no reinicia ni repite: cada golpe toma los indices siguientes', () => {
      // golpe 1: dado 1 (cara 1) -> 11, no efectivo (1 indice)
      // golpe 2: dado 8000 (cara 6) -> 16, efectivo; efecto con 3000 -> DAMAGE (2 indices)
      // golpe 3: dado 8000 (cara 6) -> 16, efectivo; efecto con 7000 -> NO_DAMAGE (2 indices)
      const sequence = new ScriptedSequence([1, 8000, 3000, 8000, 7000])
      const hit = (): ReturnType<ResolveAttack['execute']> =>
        useCase.execute({
          attack: { base: 10, dice: d6 },
          defenseValue: 11,
          table: armas,
          sequence,
        })

      const first = hit()
      const second = hit()
      const third = hit()

      expect([first.effective, second.effective, third.effective]).toEqual([false, true, true])
      expect(second.effect?.effect).toBe(D)
      expect(third.effect?.effect).toBe(N)
      expect(sequence.calls).toBe(5)
    })
  })

  describe('valida ANTES de tirar: una entrada invalida no avanza la secuencia', () => {
    it.each([
      ['Ataque base negativo', { attack: { base: -1, dice: d6 }, defenseValue: 11 }],
      ['Ataque base decimal', { attack: { base: 10.5, dice: d6 }, defenseValue: 11 }],
      ['Ataque base NaN', { attack: { base: Number.NaN, dice: d6 }, defenseValue: 11 }],
      ['Defensa negativa', { attack: { base: 10, dice: d6 }, defenseValue: -1 }],
      ['Defensa decimal', { attack: { base: 10, dice: d6 }, defenseValue: 11.5 }],
      [
        'Defensa infinita',
        { attack: { base: 10, dice: d6 }, defenseValue: Number.POSITIVE_INFINITY },
      ],
      [
        'dado sin lanzamientos',
        { attack: { base: 10, dice: { count: 0, sides: 6 } }, defenseValue: 11 },
      ],
      ['dado de 1 cara', { attack: { base: 10, dice: { count: 1, sides: 1 } }, defenseValue: 11 }],
      [
        'dado con caras decimales',
        { attack: { base: 10, dice: { count: 1, sides: 6.5 } }, defenseValue: 11 },
      ],
    ])('%s lanza DomainError y no consume ningun indice', (_label, input) => {
      const sequence = new ConstantSequence(1500)

      expect(() => useCase.execute({ ...input, table: armas, sequence })).toThrow(DomainError)
      expect(sequence.calls).toBe(0)
    })
  })

  describe('CA-07: el resultado es consistente', () => {
    it('siempre dice si fue efectivo y con que valores; el efecto solo existe si lo fue', () => {
      const missed = useCase.execute({
        attack: { base: 1, dice: null },
        defenseValue: 11,
        table: armas,
        sequence: new ScriptedSequence([]),
      })
      const hit = useCase.execute({
        attack: { base: 20, dice: null },
        defenseValue: 11,
        table: armas,
        sequence: new ScriptedSequence([1500]),
      })

      expect(Object.keys(missed).sort()).toEqual(Object.keys(hit).sort())
      expect(Object.keys(hit).sort()).toEqual([
        'attackBase',
        'attackRoll',
        'attackValue',
        'defenseValue',
        'effect',
        'effective',
      ])
      expect(typeof missed.effective).toBe('boolean')
      expect(missed.effect).toBeNull()
      expect(hit.effect).not.toBeNull()
    })

    it('no revela el indice, la fila ni la semilla', () => {
      const result = useCase.execute({
        attack: { base: 20, dice: d6 },
        defenseValue: 11,
        table: armas,
        sequence: new ScriptedSequence([2648, 3529]),
      })
      const serialized = JSON.stringify(result)

      expect(serialized).not.toMatch(/2648|3529|index|seed|semilla|fila|row/i)
    })

    it('es determinista: la misma secuencia y las mismas entradas dan el mismo resultado', () => {
      const run = (): ReturnType<ResolveAttack['execute']> =>
        useCase.execute({
          attack: { base: 10, dice: d6 },
          defenseValue: 11,
          table: armas,
          sequence: new ScriptedSequence([2648, 3529]),
        })

      expect(run()).toEqual(run())
    })
  })

  describe('usa la tabla que recibe', () => {
    it('el mismo indice resuelve efectos distintos segun la tabla del atacante', () => {
      const tanque = baseEffectTableFor(HeroSubtype.GuerreroTanque)
      const resolveWith = (table: typeof armas): RandomEffectType | undefined =>
        useCase.execute({
          attack: { base: 20, dice: null },
          defenseValue: 10,
          table,
          sequence: new ScriptedSequence([3400]),
        }).effect?.effect

      // Fila 3400: Armas -> DAMAGE (1-4800). Tanque -> EVADE (3201-3600).
      expect(resolveWith(armas)).toBe(D)
      expect(resolveWith(tanque)).toBe(E)
    })
  })

  describe('una unica fuente de aleatoriedad: la secuencia centralizada', () => {
    it('no llama a Math.random ni siquiera para el dado', () => {
      const spy = jest.spyOn(Math, 'random')

      useCase.execute({
        attack: { base: 10, dice: d6 },
        defenseValue: 11,
        table: armas,
        sequence: new ScriptedSequence([8000, 5000]),
      })

      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('un golpe efectivo usa un ResolveRandomEffect inyectable exactamente una vez', () => {
      const resolveRandomEffect = new ResolveRandomEffect()
      const execute = jest.spyOn(resolveRandomEffect, 'execute')

      new ResolveAttack(resolveRandomEffect).execute({
        attack: { base: 20, dice: null },
        defenseValue: 11,
        table: armas,
        sequence: new ScriptedSequence([1500]),
      })

      expect(execute).toHaveBeenCalledTimes(1)
    })
  })
})
