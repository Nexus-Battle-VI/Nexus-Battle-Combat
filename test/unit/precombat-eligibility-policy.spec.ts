import {
  assessPrecombatEligibility,
  HERO_CLASS_NOT_ALLOWED_FOR_FORMAT,
  HERO_NOT_READY_WITHOUT_DETAIL,
  isIndividualFormat,
  type PrecombatEligibilityBlocker,
} from '../../src/domain/policies/PrecombatEligibilityPolicy'
import { equippedProductNotOwnedBlocker } from '../fixtures/equipped-hero'

/**
 * `PrecombatEligibilityPolicy` (HU-16, RF-16, Management#25/#401/#402).
 *
 * Pura: sin dobles, sin I/O. Cubre exactamente lo que la auditoria HU-16.1
 * dejo como implementable hoy (DP-1 reenvio de blockers, DP-5 formato/clase)
 * y deja constancia, en los propios nombres de los casos, de lo que sigue
 * siendo un GAP de producto (DP-2 nivel, DP-3 nivel minimo, DP-4 mision
 * activa): esta politica no los evalua, y no debe evaluarlos hasta que
 * exista una fuente autoritativa real.
 */
describe('isIndividualFormat (DP-5): deriva 1 contra 1 de la capacidad de los equipos', () => {
  it('dos equipos de capacidad 1 SI es un enfrentamiento individual', () => {
    expect(isIndividualFormat([{ capacity: 1 }, { capacity: 1 }])).toBe(true)
  })

  it.each([
    [2, 2],
    [3, 3],
    [1, 2],
    [2, 1],
    [3, 1],
  ])('capacidades %i vs %i NO es un enfrentamiento individual', (a, b) => {
    expect(isIndividualFormat([{ capacity: a }, { capacity: b }])).toBe(false)
  })
})

const READY_INPUT = {
  heroSubtype: 'GUERRERO_TANQUE',
  individualFormat: true,
  heroReady: true,
  heroBlockers: [] as readonly PrecombatEligibilityBlocker[],
}

describe('assessPrecombatEligibility — positivos', () => {
  it('guerrero listo, 1 contra 1: elegible, sin blockers', () => {
    const result = assessPrecombatEligibility(READY_INPUT)

    expect(result).toEqual({ eligible: true, blockers: [] })
  })

  it.each(['CHAMAN', 'MEDICO'])('%s listo, en formato de EQUIPO: elegible', (heroSubtype) => {
    const result = assessPrecombatEligibility({
      ...READY_INPUT,
      heroSubtype,
      individualFormat: false,
    })

    expect(result).toEqual({ eligible: true, blockers: [] })
  })

  it.each(['GUERRERO_ARMAS', 'MAGO_FUEGO', 'MAGO_HIELO', 'PICARO_VENENO', 'PICARO_MACHETE'])(
    '%s listo, en 1 contra 1: elegible (solo Chaman/Medico se restringen)',
    (heroSubtype) => {
      const result = assessPrecombatEligibility({ ...READY_INPUT, heroSubtype })

      expect(result).toEqual({ eligible: true, blockers: [] })
    },
  )
})

describe('assessPrecombatEligibility — negativos', () => {
  it('readiness=false con blockers reales: se reenvian TAL CUAL, sin envolver ni traducir', () => {
    const result = assessPrecombatEligibility({
      ...READY_INPUT,
      heroReady: false,
      heroBlockers: [equippedProductNotOwnedBlocker],
    })

    expect(result.eligible).toBe(false)
    expect(result.blockers).toEqual([equippedProductNotOwnedBlocker])
  })

  it('readiness=false NUNCA se reinterpreta como exito, incluso sin blockers declarados', () => {
    const result = assessPrecombatEligibility({
      ...READY_INPUT,
      heroReady: false,
      heroBlockers: [],
    })

    expect(result.eligible).toBe(false)
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: HERO_NOT_READY_WITHOUT_DETAIL }),
    ])
  })

  it.each(['CHAMAN', 'MEDICO'])('%s en 1 contra 1: bloqueado (DP-5)', (heroSubtype) => {
    const result = assessPrecombatEligibility({ ...READY_INPUT, heroSubtype })

    expect(result.eligible).toBe(false)
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: HERO_CLASS_NOT_ALLOWED_FOR_FORMAT, reference: heroSubtype }),
    ])
  })

  it('un subtipo NUEVO, no registrado, NO se rechaza por esta comprobacion (falla abierto, igual que el parser)', () => {
    const result = assessPrecombatEligibility({
      ...READY_INPUT,
      heroSubtype: 'HEROE_DE_UN_SUBTIPO_NUEVO',
    })

    expect(result).toEqual({ eligible: true, blockers: [] })
  })

  it('CHAMAN no listo Y en 1 contra 1: ambos motivos concurren, ninguno oculta al otro', () => {
    const result = assessPrecombatEligibility({
      heroSubtype: 'CHAMAN',
      individualFormat: true,
      heroReady: false,
      heroBlockers: [equippedProductNotOwnedBlocker],
    })

    expect(result.eligible).toBe(false)
    expect(result.blockers).toEqual([
      equippedProductNotOwnedBlocker,
      expect.objectContaining({ code: HERO_CLASS_NOT_ALLOWED_FOR_FORMAT }),
    ])
  })
})

describe('assessPrecombatEligibility — GAPs de producto declarados, no evaluados (DP-2/DP-3/DP-4)', () => {
  it('esta politica no acepta ni evalua nivel de heroe, nivel minimo de sala ni mision activa: no hay parametros para ello', () => {
    // Documenta la superficie REAL de la funcion: solo cuatro campos. Si
    // algun dia se agregan `heroLevel`/`roomMinLevel`/`hasActiveMission`,
    // esta prueba fallara y forzara a decidir conscientemente, no a
    // ampliar la firma sin darse cuenta de que se esta resolviendo un GAP
    // de producto pendiente.
    expect(Object.keys(READY_INPUT).sort()).toEqual(
      ['heroSubtype', 'individualFormat', 'heroReady', 'heroBlockers'].sort(),
    )
  })
})
