import {
  InvalidBattleRosterError,
  UNSUPPORTED_TEAM_COMPOSITION,
  UnsupportedTeamCompositionError,
} from '../../src/domain/errors/BattleErrors'
import { assertBalancedTeams, generateTurnOrder } from '../../src/domain/policies/TurnOrderPolicy'
import { labels, memberOf, rosterOfSizes, scriptedRandom } from '../fixtures/battle'

/**
 * Generacion de la cola de turnos (HU-17, RF-17). La fuente aleatoria es un
 * doble GUIONIZADO de `BoundedRandom`: el orden de las selecciones es el
 * documentado en `generateTurnOrder` (equipo inicial, luego el barajado del
 * primer equipo y despues el del segundo).
 */
describe('generateTurnOrder — RF-17', () => {
  describe('1 contra 1: exactamente dos participantes, el seleccionado primero', () => {
    it('si el sorteo elige el primer equipo, la cola es [A1, B1]', () => {
      const order = generateTurnOrder(rosterOfSizes(1, 1), scriptedRandom([0]))

      expect(labels(order)).toEqual(['A1', 'B1'])
    })

    it('si el sorteo elige el segundo equipo, la cola es [B1, A1]', () => {
      const order = generateTurnOrder(rosterOfSizes(1, 1), scriptedRandom([1]))

      expect(labels(order)).toEqual(['B1', 'A1'])
    })

    it('la cola contiene UNICAMENTE a los dos participantes', () => {
      const order = generateTurnOrder(rosterOfSizes(1, 1), scriptedRandom([1]))

      expect(order).toHaveLength(2)
      expect(new Set(order.map((entry) => entry.playerId))).toEqual(new Set(['a1', 'b1']))
    })

    it('consume UN solo sorteo (el equipo inicial): un equipo de 1 no se baraja', () => {
      const random = scriptedRandom([1])

      generateTurnOrder(rosterOfSizes(1, 1), random)

      expect(random.bounds).toEqual([2])
    })
  })

  describe('por equipos: alternancia estricta', () => {
    it('2v2 con inicio del equipo A: A B A B', () => {
      // [equipo inicial=A, barajado A (1 sorteo), barajado B (1 sorteo)] sin intercambios.
      const order = generateTurnOrder(rosterOfSizes(2, 2), scriptedRandom([0, 1, 1]))

      expect(order.map((entry) => entry.teamLabel)).toEqual(['A', 'B', 'A', 'B'])
    })

    it('3v3 con inicio del equipo B: B A B A B A (el ejemplo de la Issue)', () => {
      const order = generateTurnOrder(rosterOfSizes(3, 3), scriptedRandom([1, 2, 1, 2, 1]))

      expect(order.map((entry) => entry.teamLabel)).toEqual(['B', 'A', 'B', 'A', 'B', 'A'])
    })

    it('3v3 con inicio del equipo A: A B A B A B', () => {
      const order = generateTurnOrder(rosterOfSizes(3, 3), scriptedRandom([0, 2, 1, 2, 1]))

      expect(order.map((entry) => entry.teamLabel)).toEqual(['A', 'B', 'A', 'B', 'A', 'B'])
    })

    it('el orden dentro de cada equipo tambien sale del sorteo (Fisher-Yates)', () => {
      // Equipo A [A1,A2,A3], indices de intercambio [0 (i=2), 0 (i=1)] => [A3?..]
      const order = generateTurnOrder(rosterOfSizes(3, 3), scriptedRandom([0, 0, 0, 2, 1]))

      // i=2: swap(2,0) -> [A3,A2,A1]; i=1: swap(1,0) -> [A2,A3,A1]
      expect(labels(order).filter((label) => label.startsWith('A'))).toEqual(['A2', 'A3', 'A1'])
    })

    it('cada sorteo del barajado tiene la cota correcta (n, n-1, ..., 2) tras el sorteo del equipo', () => {
      const random = scriptedRandom([0, 0, 0, 0, 0])

      generateTurnOrder(rosterOfSizes(3, 3), random)

      expect(random.bounds).toEqual([2, 3, 2, 3, 2])
    })

    it.each([1, 2, 3])('%ix%i: la alternancia no se interrumpe nunca', (size) => {
      const order = generateTurnOrder(
        rosterOfSizes(size, size),
        scriptedRandom([1, ...Array.from({ length: (size - 1) * 2 }, () => 0)]),
      )

      expect(order).toHaveLength(size * 2)
      expect(order.map((entry) => entry.teamLabel)).toEqual(
        Array.from({ length: size * 2 }, (_, index) => (index % 2 === 0 ? 'B' : 'A')),
      )
    })
  })

  /**
   * RF-17 exige alternar entre ambos equipos pero NO define que pasa cuando uno se
   * agota antes. Esa regla no esta ratificada: HU-17 no la inventa y rechaza la
   * composicion ANTES de consumir ningun sorteo.
   */
  describe('equipos de distinto tamano: no hay regla ratificada, no se fabrica una cola', () => {
    it.each([
      [1, 2],
      [2, 1],
      [1, 3],
      [3, 1],
      [2, 3],
      [3, 2],
    ])(
      '%ix%i se rechaza con UnsupportedTeamCompositionError y NO consume ningun sorteo',
      (a, b) => {
        const random = scriptedRandom([0, 0, 0, 0, 0, 0])

        expect(() => generateTurnOrder(rosterOfSizes(a, b), random)).toThrow(
          UnsupportedTeamCompositionError,
        )
        expect(random.bounds).toEqual([])
      },
    )

    it('el error lleva un codigo estable y los tamanos, sin datos internos', () => {
      let caught: unknown

      try {
        assertBalancedTeams(rosterOfSizes(1, 3))
      } catch (error: unknown) {
        caught = error
      }

      expect(caught).toBeInstanceOf(UnsupportedTeamCompositionError)
      expect((caught as UnsupportedTeamCompositionError).code).toBe(UNSUPPORTED_TEAM_COMPOSITION)
      expect((caught as UnsupportedTeamCompositionError).sizes).toEqual([1, 3])
      expect((caught as Error).message).toContain('1 contra 3')
    })

    it('equipos del mismo tamano pasan la comprobacion', () => {
      expect(() => {
        assertBalancedTeams(rosterOfSizes(2, 2))
      }).not.toThrow()
    })
  })

  describe('las estadisticas y el equipamiento NO influyen', () => {
    it('la misma fuente aleatoria da el mismo orden aunque cambien subtipo, heroe y nombre', () => {
      const plain = generateTurnOrder(rosterOfSizes(2, 2), scriptedRandom([1, 0, 1]))
      const changed = generateTurnOrder(
        [
          {
            label: 'A',
            members: [
              memberOf('A', 0, { heroSubtype: 'MAGO_HIELO', heroId: 'otro' }),
              memberOf('A', 1, { heroSubtype: 'CHAMAN', displayName: 'zzz' }),
            ],
          },
          {
            label: 'B',
            members: [
              memberOf('B', 0, { heroSubtype: 'MEDICO' }),
              memberOf('B', 1, { heroSubtype: 'PICARO_VENENO', heroId: null }),
            ],
          },
        ],
        scriptedRandom([1, 0, 1]),
      )

      expect(labels(changed)).toEqual(labels(plain))
    })

    it('la funcion ni siquiera recibe estadisticas: solo participantes por equipo', () => {
      expect(generateTurnOrder.length).toBe(2)
    })
  })

  describe('determinismo y resultado', () => {
    it('es determinista para una misma secuencia de sorteos', () => {
      const first = generateTurnOrder(rosterOfSizes(3, 3), scriptedRandom([1, 1, 0, 2, 0]))
      const second = generateTurnOrder(rosterOfSizes(3, 3), scriptedRandom([1, 1, 0, 2, 0]))

      expect(labels(first)).toEqual(labels(second))
    })

    it('no muta el roster recibido', () => {
      const roster = rosterOfSizes(3, 3)
      const before = JSON.stringify(roster)

      generateTurnOrder(roster, scriptedRandom([1, 2, 1, 2, 1]))

      expect(JSON.stringify(roster)).toBe(before)
    })

    it('todos los participantes aparecen exactamente una vez', () => {
      const order = generateTurnOrder(rosterOfSizes(3, 3), scriptedRandom([0, 1, 0, 1, 0]))

      expect(new Set(labels(order))).toEqual(new Set(['A1', 'A2', 'A3', 'B1', 'B2', 'B3']))
      expect(order).toHaveLength(6)
    })
  })

  describe('rosters invalidos: ninguna cola', () => {
    it('un equipo sin participantes', () => {
      expect(() => generateTurnOrder(rosterOfSizes(0, 2), scriptedRandom([0]))).toThrow(
        InvalidBattleRosterError,
      )
    })

    it('etiquetas de equipo repetidas', () => {
      expect(() =>
        generateTurnOrder(
          [
            { label: 'A', members: [memberOf('A', 0)] },
            { label: 'A', members: [memberOf('A', 1)] },
          ],
          scriptedRandom([0]),
        ),
      ).toThrow(InvalidBattleRosterError)
    })

    it('un participante que no pertenece al equipo donde se declara', () => {
      expect(() =>
        generateTurnOrder(
          [
            { label: 'A', members: [memberOf('B', 0)] },
            { label: 'B', members: [memberOf('B', 1)] },
          ],
          scriptedRandom([0]),
        ),
      ).toThrow(InvalidBattleRosterError)
    })

    it('el mismo asiento duplicado', () => {
      expect(() =>
        generateTurnOrder(
          [
            { label: 'A', members: [memberOf('A', 0), memberOf('A', 0, { playerId: 'x' })] },
            { label: 'B', members: [memberOf('B', 0)] },
          ],
          scriptedRandom([0, 0]),
        ),
      ).toThrow(InvalidBattleRosterError)
    })

    it('el mismo jugador en dos puestos', () => {
      expect(() =>
        generateTurnOrder(
          [
            { label: 'A', members: [memberOf('A', 0)] },
            { label: 'B', members: [memberOf('B', 0, { playerId: 'a1' })] },
          ],
          scriptedRandom([0]),
        ),
      ).toThrow(InvalidBattleRosterError)
    })
  })
})
