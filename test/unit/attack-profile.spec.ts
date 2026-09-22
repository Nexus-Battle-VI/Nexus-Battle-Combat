import { DomainError } from '../../src/domain/errors/DomainError'
import {
  ATTACK_DICE,
  assertAttackDie,
  attackDiceFor,
  dieFaceFromIndex,
} from '../../src/domain/policies/AttackProfile'
import { HeroSubtype, HERO_SUBTYPES } from '../../src/domain/value-objects/HeroSubtype'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'

/**
 * Dados de Ataque (Tabla 6, columna «Ataque») y su tirada a partir de un
 * indice de la secuencia centralizada (HU-24).
 */
describe('Dados de Ataque por subtipo (Tabla 6)', () => {
  /** Tabla 6, transcripcion LITERAL e independiente de `ATTACK_DICE`. */
  const TABLE_6: readonly (readonly [HeroSubtype, number | null])[] = [
    [HeroSubtype.GuerreroTanque, 6],
    [HeroSubtype.GuerreroArmas, 6],
    [HeroSubtype.MagoFuego, 8],
    [HeroSubtype.MagoHielo, 8],
    [HeroSubtype.PicaroVeneno, 10],
    [HeroSubtype.PicaroMachete, 10],
    [HeroSubtype.Chaman, null],
    [HeroSubtype.Medico, null],
  ]

  it.each(TABLE_6)('%s: 10 + 1d%s (los sanadores no tienen Ataque)', (subtype, sides) => {
    expect(attackDiceFor(subtype)).toEqual(sides === null ? null : { count: 1, sides })
  })

  it('cubre exactamente los ocho subtipos del registro, ni uno mas ni uno menos', () => {
    expect(Object.keys(ATTACK_DICE).sort()).toEqual([...HERO_SUBTYPES].sort())
    expect(TABLE_6.map(([subtype]) => subtype).sort()).toEqual([...HERO_SUBTYPES].sort())
  })

  it('los sanadores no llevan dado de Ataque', () => {
    expect(attackDiceFor(HeroSubtype.Chaman)).toBeNull()
    expect(attackDiceFor(HeroSubtype.Medico)).toBeNull()
  })

  describe('reglas autoritativas congeladas en runtime', () => {
    it('el registro y cada dado estan congelados', () => {
      expect(Object.isFrozen(ATTACK_DICE)).toBe(true)

      for (const die of Object.values(ATTACK_DICE)) {
        if (die !== null) {
          expect(Object.isFrozen(die)).toBe(true)
        }
      }
    })

    it('intentar cambiar un dado o el registro lanza TypeError y no altera nada', () => {
      const armas = ATTACK_DICE[HeroSubtype.GuerreroArmas]

      expect(() => {
        if (armas !== null) {
          ;(armas as { sides: number }).sides = 20
        }
      }).toThrow(TypeError)
      expect(() => {
        ;(ATTACK_DICE as Record<string, unknown>)[HeroSubtype.Chaman] = { count: 1, sides: 6 }
      }).toThrow(TypeError)

      expect(attackDiceFor(HeroSubtype.GuerreroArmas)).toEqual({ count: 1, sides: 6 })
      expect(attackDiceFor(HeroSubtype.Chaman)).toBeNull()
    })
  })
})

describe('dieFaceFromIndex: la cara sale del indice uniforme 1..8000', () => {
  const face = (index: number, sides: number): number =>
    dieFaceFromIndex(RandomIndex.create(index), sides)

  const distribution = (sides: number): number[] => {
    const counts = new Array<number>(sides).fill(0)

    for (let index = 1; index <= RandomIndex.MAX; index += 1) {
      const value = face(index, sides)

      counts[value - 1] = (counts[value - 1] ?? 0) + 1
    }

    return counts
  }

  it.each([
    [1, 6, 1],
    [1333, 6, 1],
    [1334, 6, 1],
    [1335, 6, 2],
    [4000, 6, 3],
    [4001, 6, 4],
    [8000, 6, 6],
    [1, 8, 1],
    [1000, 8, 1],
    [1001, 8, 2],
    [8000, 8, 8],
    [1, 10, 1],
    [800, 10, 1],
    [801, 10, 2],
    [8000, 10, 10],
  ])('el indice %i con un d%i da la cara %i', (index, sides, expected) => {
    expect(face(index, sides)).toBe(expected)
  })

  it('con 8 caras el reparto es EXACTO: 1000 filas por cara', () => {
    expect(distribution(8)).toEqual(new Array<number>(8).fill(1000))
  })

  it('con 10 caras el reparto es EXACTO: 800 filas por cara', () => {
    expect(distribution(10)).toEqual(new Array<number>(10).fill(800))
  })

  it('con 6 caras 8000 no es multiplo: dos caras reciben una fila mas (1334 contra 1333)', () => {
    const counts = distribution(6)

    expect(counts).toEqual([1334, 1333, 1333, 1334, 1333, 1333])
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(8000)
    expect(Math.max(...counts) - Math.min(...counts)).toBe(1)
  })

  it.each([2, 3, 6, 8, 10, 12, 20, 100])(
    'un d%i nunca sale de 1..caras para ningun indice',
    (sides) => {
      for (let index = 1; index <= RandomIndex.MAX; index += 1) {
        const value = face(index, sides)

        expect(value).toBeGreaterThanOrEqual(1)
        expect(value).toBeLessThanOrEqual(sides)
      }
    },
  )

  it('es funcion pura del indice: el mismo indice da siempre la misma cara', () => {
    expect(face(2648, 6)).toBe(face(2648, 6))
    expect(face(2648, 6)).toBe(2)
  })

  it.each([0, 1, -1, 1.5, Number.NaN])('un dado de %p caras es invalido', (sides) => {
    expect(() => dieFaceFromIndex(RandomIndex.create(10), sides)).toThrow(DomainError)
  })
})

describe('assertAttackDie: rechaza un dado mal formado antes de tirar', () => {
  it('acepta 1d6 y 2d10', () => {
    expect(() => {
      assertAttackDie({ count: 1, sides: 6 })
    }).not.toThrow()
    expect(() => {
      assertAttackDie({ count: 2, sides: 10 })
    }).not.toThrow()
  })

  it.each([0, -1, 1.5, Number.NaN])('rechaza %p lanzamientos', (count) => {
    expect(() => {
      assertAttackDie({ count, sides: 6 })
    }).toThrow(/al menos 1 lanzamiento entero/)
  })

  it.each([0, 1, -3, 2.5, Number.NaN])('rechaza %p caras', (sides) => {
    expect(() => {
      assertAttackDie({ count: 1, sides })
    }).toThrow(/al menos 2 caras enteras/)
  })
})
