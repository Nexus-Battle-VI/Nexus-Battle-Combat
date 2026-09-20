import { DomainError } from '../../src/domain/errors/DomainError'
import {
  HERO_SUBTYPES,
  HeroSubtype,
  parseHeroSubtype,
} from '../../src/domain/value-objects/HeroSubtype'

/**
 * El vocabulario NO es nuevo: son los ocho codigos de `hero-subtypes-v1` que
 * Catalog publica y Player-Inventory devuelve en `subtype` (auditado en los
 * repositorios respectivos). Esta lista literal detecta cualquier divergencia.
 */
const REGISTRY_V1 = [
  'GUERRERO_TANQUE',
  'GUERRERO_ARMAS',
  'MAGO_FUEGO',
  'MAGO_HIELO',
  'PICARO_VENENO',
  'PICARO_MACHETE',
  'CHAMAN',
  'MEDICO',
]

describe('HeroSubtype', () => {
  it('conserva EXACTAMENTE los ocho codigos del registro hero-subtypes-v1', () => {
    expect([...HERO_SUBTYPES].sort()).toEqual([...REGISTRY_V1].sort())
    expect(HERO_SUBTYPES).toHaveLength(8)
  })

  it.each(REGISTRY_V1)('parseHeroSubtype acepta %s', (code) => {
    expect(parseHeroSubtype(code)).toBe(code)
  })

  it.each(['guerrero_armas', ' GUERRERO_ARMAS', 'GUERRERO', 'WARRIOR_WEAPONS', 'MAGE_FIRE', ''])(
    'parseHeroSubtype rechaza el codigo no normalizado o inventado %p',
    (code) => {
      expect(() => parseHeroSubtype(code)).toThrow(DomainError)
      expect(() => parseHeroSubtype(code)).toThrow(/hero-subtypes-v1/)
    },
  )

  it.each([null, undefined, 1, {}, ['MAGO_FUEGO']])(
    'parseHeroSubtype rechaza el valor no textual %p',
    (value) => {
      expect(() => parseHeroSubtype(value)).toThrow(DomainError)
    },
  )

  it('expone los subtipos con nombres de la Tabla 21', () => {
    expect(HeroSubtype.GuerreroArmas).toBe('GUERRERO_ARMAS')
    expect(HeroSubtype.PicaroMachete).toBe('PICARO_MACHETE')
  })
})
