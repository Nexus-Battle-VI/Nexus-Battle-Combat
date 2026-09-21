import { InvalidBattleRosterError } from '../../src/domain/errors/BattleErrors'
import { generateTurnOrder } from '../../src/domain/policies/TurnOrderPolicy'
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

    it.each([
      [1, 2],
      [2, 1],
      [1, 3],
      [3, 1],
      [2, 3],
      [3, 2],
    ])(
      'composicion desigual %ix%i: alterna mientras ambos tengan integrantes y luego anade los que restan',
      (sizeA, sizeB) => {
        const values = [1, ...Array.from({ length: sizeA - 1 + (sizeB - 1) }, () => 0)]
        const order = generateTurnOrder(rosterOfSizes(sizeA, sizeB), scriptedRandom(values))

        expect(order).toHaveLength(sizeA + sizeB)

        // Inicia el equipo B. Se alterna hasta que el menor se agota.
        const shared = Math.min(sizeA, sizeB) * 2

        for (let index = 0; index < shared; index += 1) {
          expect(order[index]?.teamLabel).toBe(index % 2 === 0 ? 'B' : 'A')
        }

        expect(new Set(labels(order)).size).toBe(sizeA + sizeB)
      },
    )
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
