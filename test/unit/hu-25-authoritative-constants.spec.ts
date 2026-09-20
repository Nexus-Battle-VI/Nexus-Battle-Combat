import {
  BASE_EFFECT_PERCENTAGES,
  baseEffectTableFor,
} from '../../src/domain/random-effects/BaseEffectProfiles'
import { EFFECT_MAGNITUDES } from '../../src/domain/random-effects/EffectMagnitude'
import {
  RANDOM_EFFECT_ORDER,
  RandomEffectType,
} from '../../src/domain/random-effects/RandomEffectType'
import {
  HERO_SUBTYPES,
  HeroSubtype,
  parseHeroSubtype,
} from '../../src/domain/value-objects/HeroSubtype'

/**
 * `readonly` de TypeScript solo protege en compilacion: desde JavaScript (o con
 * un cast) alguien podria alterar una regla autoritativa del dominio y, con
 * ella, la forma de construir TODAS las tablas. Estas pruebas intentan
 * precisamente esas mutaciones y comprueban que fallan (los modulos de TypeScript
 * se ejecutan en modo estricto, asi que escribir en un objeto congelado lanza
 * `TypeError`).
 */
const ORDER = ['DAMAGE', 'CRITICAL_DAMAGE', 'EVADE', 'RESIST', 'ESCAPE', 'NO_DAMAGE']

const REGISTRY = [
  'GUERRERO_TANQUE',
  'GUERRERO_ARMAS',
  'MAGO_FUEGO',
  'MAGO_HIELO',
  'PICARO_VENENO',
  'PICARO_MACHETE',
  'CHAMAN',
  'MEDICO',
]

describe('Constantes autoritativas de HU-25 congeladas en runtime', () => {
  describe('RANDOM_EFFECT_ORDER (orden fijo de la tabla)', () => {
    it('esta congelado', () => {
      expect(Object.isFrozen(RANDOM_EFFECT_ORDER)).toBe(true)
    })

    it.each([
      ['reverse()', (list: string[]) => list.reverse()],
      ['sort()', (list: string[]) => list.sort()],
      ['push()', (list: string[]) => list.push('STUN')],
      ['pop()', (list: string[]) => list.pop()],
      ['shift()', (list: string[]) => list.shift()],
      ['splice()', (list: string[]) => list.splice(0, 1)],
      [
        'asignar un indice',
        (list: string[]) => {
          list[0] = 'NO_DAMAGE'
        },
      ],
      [
        'truncar length',
        (list: string[]) => {
          list.length = 0
        },
      ],
    ])('%s lanza TypeError y no altera el orden', (_label, mutate) => {
      expect(() => {
        mutate(RANDOM_EFFECT_ORDER as unknown as string[])
      }).toThrow(TypeError)
      expect([...RANDOM_EFFECT_ORDER]).toEqual(ORDER)
    })

    it('un intento de alterarlo NO cambia como se construyen las tablas (Tabla 22 intacta)', () => {
      try {
        ;(RANDOM_EFFECT_ORDER as unknown as string[]).reverse()
      } catch {
        // Esperado: TypeError. Lo que importa es lo que ocurre despues.
      }

      const table = baseEffectTableFor(HeroSubtype.GuerreroArmas)

      expect(table.ranges.map((range) => [range.effect, range.firstRow, range.lastRow])).toEqual([
        ['DAMAGE', 1, 4800],
        ['CRITICAL_DAMAGE', 4801, 5200],
        ['EVADE', 5201, 5440],
        ['ESCAPE', 5441, 5600],
        ['NO_DAMAGE', 5601, 8000],
      ])
    })
  })

  describe('HERO_SUBTYPES (registro hero-subtypes-v1)', () => {
    it('esta congelado', () => {
      expect(Object.isFrozen(HERO_SUBTYPES)).toBe(true)
    })

    it.each([
      ['reverse()', (list: string[]) => list.reverse()],
      ['push()', (list: string[]) => list.push('WARRIOR_WEAPONS')],
      ['pop()', (list: string[]) => list.pop()],
      ['splice()', (list: string[]) => list.splice(0, 1)],
      [
        'asignar un indice',
        (list: string[]) => {
          list[0] = 'MEDICO'
        },
      ],
    ])('%s lanza TypeError y no altera el registro', (_label, mutate) => {
      expect(() => {
        mutate(HERO_SUBTYPES as unknown as string[])
      }).toThrow(TypeError)
      expect([...HERO_SUBTYPES]).toEqual(REGISTRY)
    })

    it('un intento de ampliarlo NO hace valido un subtipo inventado', () => {
      try {
        ;(HERO_SUBTYPES as unknown as string[]).push('WARRIOR_WEAPONS')
      } catch {
        // Esperado: TypeError.
      }

      expect(() => parseHeroSubtype('WARRIOR_WEAPONS')).toThrow()
    })
  })

  describe('los objetos que declaran los valores', () => {
    it.each([
      ['RandomEffectType', RandomEffectType],
      ['HeroSubtype', HeroSubtype],
      ['EFFECT_MAGNITUDES', EFFECT_MAGNITUDES],
      ['BASE_EFFECT_PERCENTAGES', BASE_EFFECT_PERCENTAGES],
    ])('%s esta congelado', (_name, value) => {
      expect(Object.isFrozen(value)).toBe(true)
    })

    it('reasignar o anadir claves lanza TypeError', () => {
      const effects = RandomEffectType as unknown as Record<string, string>
      const subtypes = HeroSubtype as unknown as Record<string, string>

      expect(() => {
        effects.Damage = 'NO_DAMAGE'
      }).toThrow(TypeError)
      expect(() => {
        effects.Stun = 'STUN'
      }).toThrow(TypeError)
      expect(() => {
        subtypes.Chaman = 'GUERRERO_ARMAS'
      }).toThrow(TypeError)

      expect(RandomEffectType.Damage).toBe('DAMAGE')
      expect(HeroSubtype.Chaman).toBe('CHAMAN')
    })

    it('las magnitudes y las configuraciones por heroe tambien estan congeladas por dentro', () => {
      for (const magnitude of Object.values(EFFECT_MAGNITUDES)) {
        expect(Object.isFrozen(magnitude)).toBe(true)
      }

      for (const profile of Object.values(BASE_EFFECT_PERCENTAGES)) {
        expect(Object.isFrozen(profile)).toBe(true)
      }
    })
  })
})
