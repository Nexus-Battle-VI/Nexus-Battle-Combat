import { RandomSelectionExhaustedError } from '../../src/domain/errors/BattleErrors'
import { createBoundedRandom } from '../../src/application/services/BoundedRandom'
import { scriptedSequence } from '../fixtures/battle'

/**
 * Seleccion uniforme acotada sobre la fuente HU-24 (indices 1..8000), sin
 * sesgo de modulo (muestreo por rechazo).
 */
describe('createBoundedRandom — muestreo por rechazo sobre HU-24', () => {
  const allIndices = Array.from({ length: 8000 }, (_, index) => index + 1)

  describe('uniformidad EXACTA: recorriendo los 8000 indices posibles', () => {
    it.each([2, 3, 4, 5, 6])(
      'bound %i: cada resultado aceptado ocurre el MISMO numero de veces',
      (bound) => {
        const counts = new Array<number>(bound).fill(0)
        let rejected = 0

        for (const index of allIndices) {
          // Con un unico indice disponible, un rechazo agota la secuencia: se cuenta como rechazo.
          const sequence = scriptedSequence([index])
          const random = createBoundedRandom(sequence)

          try {
            const value = random.nextInt(bound)

            counts[value] = (counts[value] ?? 0) + 1
          } catch {
            rejected += 1
          }
        }

        const limit = 8000 - (8000 % bound)

        expect(new Set(counts).size).toBe(1)
        expect(counts[0]).toBe(limit / bound)
        expect(rejected).toBe(8000 % bound)
      },
    )

    it('el modulo ingenuo SI seria sesgado para 3 (los residuos bajos ganan una fila): el rechazo lo evita', () => {
      const naive = new Array<number>(3).fill(0)

      for (const index of allIndices) {
        naive[(index - 1) % 3] = (naive[(index - 1) % 3] ?? 0) + 1
      }

      expect(naive).toEqual([2667, 2667, 2666])
    })
  })

  describe('consumo de la fuente', () => {
    it('bound 1 no consume ningun indice', () => {
      const sequence = scriptedSequence([])

      expect(createBoundedRandom(sequence).nextInt(1)).toBe(0)
      expect(sequence.consumed()).toBe(0)
    })

    it('bound 2 consume exactamente un indice y nunca rechaza (2 divide 8000)', () => {
      const sequence = scriptedSequence([1, 8000, 4001])
      const random = createBoundedRandom(sequence)

      expect([random.nextInt(2), random.nextInt(2), random.nextInt(2)]).toEqual([0, 1, 0])
      expect(sequence.consumed()).toBe(3)
    })

    it('bound 3 rechaza los indices 7999 y 8000 y toma otro: cuesta un indice extra por rechazo', () => {
      const sequence = scriptedSequence([8000, 7999, 5])
      const random = createBoundedRandom(sequence)

      expect(random.nextInt(3)).toBe((5 - 1) % 3)
      expect(sequence.consumed()).toBe(3)
    })

    it('agota el tope de intentos con una fuente que solo rechaza: error, nunca bucle infinito', () => {
      const sequence = scriptedSequence(Array.from({ length: 64 }, () => 8000))

      expect(() => createBoundedRandom(sequence).nextInt(3)).toThrow(RandomSelectionExhaustedError)
      expect(sequence.consumed()).toBe(64)
    })
  })

  describe('entradas invalidas', () => {
    it.each([0, -1, 1.5, Number.NaN, 8001])('bound %p lanza RangeError', (bound) => {
      expect(() => createBoundedRandom(scriptedSequence([1])).nextInt(bound)).toThrow(RangeError)
    })
  })
})
