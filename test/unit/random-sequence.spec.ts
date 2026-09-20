import { inspect } from 'node:util'

import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import type { NormalToIndexMapper } from '../../src/adapters/outbound/system/RandomnessContracts'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

const factory = (): Mt19937BoxMullerRandomSequenceFactory =>
  new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())

const indices = (sequence: RandomSequencePort, count: number): number[] =>
  Array.from({ length: count }, () => sequence.nextIndex().value)

/**
 * Secuencia stateful (HU-24): la semilla se entrega al CREAR y el estado avanza
 * en cada llamada. Es el comportamiento que necesitara una batalla de varios
 * turnos.
 */
describe('Mt19937BoxMullerRandomSequenceFactory', () => {
  describe('reproducibilidad', () => {
    it('recrear la misma semilla reproduce exactamente la misma secuencia de indices', () => {
      const seed = RandomSeed.create(3_000_000)

      expect(indices(factory().create(seed), 500)).toEqual(indices(factory().create(seed), 500))
    })

    it('semillas distintas producen secuencias distintas', () => {
      const a = indices(factory().create(RandomSeed.create(1)), 20)
      const b = indices(factory().create(RandomSeed.create(2)), 20)

      expect(a).not.toEqual(b)
    })

    it('la misma fabrica crea secuencias independientes: no hay cursor global compartido', () => {
      const shared = factory()
      const seed = RandomSeed.create(777)
      const first = shared.create(seed)
      const second = shared.create(seed)

      indices(first, 50)

      // `second` no vio avanzar a `first`.
      expect(indices(second, 5)).toEqual(indices(factory().create(seed), 5))
    })
  })

  describe('no reinicializa la semilla en cada solicitud', () => {
    it('llamadas sucesivas avanzan el estado y no repiten el primer valor', () => {
      const sequence = factory().create(RandomSeed.create(42))
      const values = indices(sequence, 400)

      expect(new Set(values).size).toBeGreaterThan(350)
    })

    it('reconstruir la secuencia en cada llamada SI repite siempre el primer valor (anti-patron)', () => {
      // Documenta el error que el diseno evita: `create(seed).nextIndex()` en
      // bucle devuelve siempre lo mismo.
      const seed = RandomSeed.create(42)
      const repeated = Array.from({ length: 5 }, () => factory().create(seed).nextIndex().value)

      expect(new Set(repeated).size).toBe(1)
    })
  })

  describe('nextNormal y nextIndex comparten la misma secuencia', () => {
    it('el indice n-esimo es el mapeo de la normal n-esima', () => {
      const seed = RandomSeed.create(5489)
      const mapper = new CdfUniformIndexMapper()
      const asNormals = factory().create(seed)
      const asIndices = factory().create(seed)

      for (let i = 0; i < 100; i += 1) {
        expect(asIndices.nextIndex().value).toBe(mapper.map(asNormals.nextNormal()).value)
      }
    })

    it('intercalarlos avanza un unico estado (aprovecha Z0 y Z1 de la misma pareja)', () => {
      const seed = RandomSeed.create(5489)
      const mapper = new CdfUniformIndexMapper()
      const mixed = factory().create(seed)
      const reference = factory().create(seed)

      const normal0 = mixed.nextNormal()
      const index1 = mixed.nextIndex()

      expect(normal0).toBe(reference.nextNormal())
      expect(index1.value).toBe(mapper.map(reference.nextNormal()).value)
    })
  })

  describe('el mapper es intercambiable sin tocar el generador', () => {
    it('otra estrategia cambia los indices pero NO las normales', () => {
      const seed = RandomSeed.create(2026)
      const constantMapper: NormalToIndexMapper = { map: () => RandomIndex.create(1234) }
      const custom = new Mt19937BoxMullerRandomSequenceFactory(constantMapper).create(seed)
      const standard = factory().create(seed)

      expect(custom.nextIndex().value).toBe(1234)

      // El generador normal subyacente es el mismo: la siguiente normal coincide.
      standard.nextNormal()
      expect(custom.nextNormal()).toBe(standard.nextNormal())
    })
  })

  describe('seguridad', () => {
    it('no usa Math.random en ningun momento', () => {
      const spy = jest.spyOn(Math, 'random')

      try {
        const sequence = factory().create(RandomSeed.create(1))
        indices(sequence, 2_000)
        sequence.nextNormal()

        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })

    it('la secuencia no expone semilla ni estado al serializarse o inspeccionarse', () => {
      const seedValue = 3_141_592
      const sequence = factory().create(RandomSeed.create(seedValue))
      indices(sequence, 3)

      expect(JSON.stringify(sequence)).toBe('{}')
      expect(Object.keys(sequence)).toEqual([])
      expect(Object.getOwnPropertyNames(sequence)).toEqual([])
      expect(inspect(sequence, { showHidden: true, depth: 5 })).not.toContain(String(seedValue))
    })

    it('la fabrica tampoco expone estado', () => {
      expect(JSON.stringify(factory())).toBe('{}')
      expect(Object.keys(factory())).toEqual([])
    })
  })
})
