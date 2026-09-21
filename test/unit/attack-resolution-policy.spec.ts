import { DomainError } from '../../src/domain/errors/DomainError'
import {
  assertCombatValue,
  compareAttackAgainstDefense,
} from '../../src/domain/policies/AttackResolutionPolicy'

/**
 * HU-20 (RF-20), regla pura: el golpe es efectivo si y solo si el Ataque SUPERA
 * (estrictamente) la Defensa. Casos positivo, negativo y de frontera (CA-04,
 * CA-05).
 */
describe('compareAttackAgainstDefense (HU-20)', () => {
  describe('CA-05: el Ataque supera la Defensa -> golpe efectivo', () => {
    it.each([
      [11, 10],
      [13, 11],
      [16, 11],
      [1, 0],
      [100, 4],
    ])('Ataque %i contra Defensa %i es efectivo', (attack, defense) => {
      expect(compareAttackAgainstDefense(attack, defense).effective).toBe(true)
    })
  })

  describe('CA-04: el Ataque no supera la Defensa -> el golpe no produce efecto', () => {
    it.each([
      [10, 11],
      [9, 11],
      [0, 4],
      [10, 100],
    ])('Ataque %i contra Defensa %i no es efectivo', (attack, defense) => {
      expect(compareAttackAgainstDefense(attack, defense).effective).toBe(false)
    })
  })

  describe('frontera: la igualdad NO supera', () => {
    it.each([0, 1, 4, 10, 11, 16, 1000])('Ataque = Defensa = %i no es efectivo', (value) => {
      expect(compareAttackAgainstDefense(value, value).effective).toBe(false)
    })

    it.each([0, 4, 10, 11, 16])('Defensa %i: Ataque +1 es efectivo y Ataque -1 no', (defense) => {
      expect(compareAttackAgainstDefense(defense + 1, defense).effective).toBe(true)
      expect(compareAttackAgainstDefense(Math.max(0, defense - 1), defense).effective).toBe(false)
    })

    it('0 contra 0 no es efectivo (un heroe sin Ataque no supera una Defensa nula)', () => {
      expect(compareAttackAgainstDefense(0, 0).effective).toBe(false)
    })
  })

  describe('el orden importa: el Ataque va primero y la Defensa segundo', () => {
    it('intercambiar los argumentos cambia el resultado', () => {
      expect(compareAttackAgainstDefense(12, 11).effective).toBe(true)
      expect(compareAttackAgainstDefense(11, 12).effective).toBe(false)
    })
  })

  describe('devuelve de forma consistente los valores comparados (CA-07)', () => {
    it('trae el Ataque, la Defensa y el indicador, y nada mas', () => {
      const comparison = compareAttackAgainstDefense(13, 11)

      expect(comparison).toEqual({ attackValue: 13, defenseValue: 11, effective: true })
      expect(Object.keys(comparison).sort()).toEqual(['attackValue', 'defenseValue', 'effective'])
    })

    it('es pura: la misma entrada da siempre la misma salida y no guarda estado', () => {
      const first = compareAttackAgainstDefense(12, 11)
      const second = compareAttackAgainstDefense(12, 11)
      const other = compareAttackAgainstDefense(5, 11)

      expect(second).toEqual(first)
      expect(other.effective).toBe(false)
      expect(compareAttackAgainstDefense(12, 11)).toEqual(first)
    })
  })

  describe('rechaza valores que no son enteros no negativos, sin adivinar', () => {
    it.each([
      ['un decimal', 10.5],
      ['un negativo', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('el Ataque %s lanza DomainError', (_label, value) => {
      expect(() => compareAttackAgainstDefense(value, 10)).toThrow(DomainError)
      expect(() => compareAttackAgainstDefense(value, 10)).toThrow(/valor de Ataque/)
    })

    it.each([
      ['un decimal', 10.5],
      ['un negativo', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('la Defensa %s lanza DomainError', (_label, value) => {
      expect(() => compareAttackAgainstDefense(10, value)).toThrow(DomainError)
      expect(() => compareAttackAgainstDefense(10, value)).toThrow(/valor de Defensa/)
    })

    it('un valor que no es un numero en tiempo de ejecucion tambien se rechaza', () => {
      const notANumber: unknown = '12'

      expect(() => compareAttackAgainstDefense(notANumber as number, 10)).toThrow(DomainError)
    })
  })
})

describe('assertCombatValue (HU-20)', () => {
  it.each([0, 1, 10, 4_000])('acepta el entero no negativo %i', (value) => {
    expect(() => {
      assertCombatValue(value, 'X')
    }).not.toThrow()
  })

  it('el mensaje incluye la etiqueta y el valor recibido', () => {
    expect(() => {
      assertCombatValue(-3, 'El Ataque base')
    }).toThrow('El Ataque base debe ser un entero no negativo. Se recibio -3.')
  })
})
