import { ResolveRandomEffect } from '../../src/application/use-cases/ResolveRandomEffect'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import { baseEffectTableFor } from '../../src/domain/random-effects/BaseEffectProfiles'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'

/**
 * Secuencia de prueba DETERMINISTA: devuelve los indices dados en orden y cuenta
 * las llamadas. No hay generador real: HU-25 se prueba sin HU-24.
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

describe('ResolveRandomEffect', () => {
  const table = baseEffectTableFor(HeroSubtype.GuerreroArmas)
  const useCase = new ResolveRandomEffect()

  it('resuelve el efecto de la fila que entrega la secuencia', () => {
    const sequence = new ScriptedSequence([1500, 4801, 5300, 5500, 7000])

    expect(Array.from({ length: 5 }, () => useCase.execute({ sequence, table }).effect)).toEqual([
      RandomEffectType.Damage,
      RandomEffectType.CriticalDamage,
      RandomEffectType.Evade,
      RandomEffectType.Escape,
      RandomEffectType.NoDamage,
    ])
  })

  it('consume EXACTAMENTE un indice por golpe efectivo (el avance de la secuencia es predecible)', () => {
    const sequence = new ScriptedSequence([10, 20, 30])

    useCase.execute({ sequence, table })
    expect(sequence.calls).toBe(1)

    useCase.execute({ sequence, table })
    useCase.execute({ sequence, table })
    expect(sequence.calls).toBe(3)
  })

  it('devuelve efecto, magnitud y porcentaje concreto, y nada mas', () => {
    const resolved = useCase.execute({ sequence: new ScriptedSequence([4801]), table })

    // Fila 4801 = primera del critico: el intervalo 120..180 se materializa en 120.
    expect(resolved).toEqual({
      effect: RandomEffectType.CriticalDamage,
      magnitude: { kind: 'PERCENT_RANGE', minPercent: 120, maxPercent: 180 },
      percent: 120,
    })
  })

  it('el mismo indice contra tablas distintas resuelve efectos distintos (la tabla es del heroe)', () => {
    const tanque = baseEffectTableFor(HeroSubtype.GuerreroTanque)
    const fila = 3400 // Armas: DAMAGE (1-4800). Tanque: EVADE (3201-3600).

    expect(useCase.execute({ sequence: new ScriptedSequence([fila]), table }).effect).toBe(
      RandomEffectType.Damage,
    )
    expect(useCase.execute({ sequence: new ScriptedSequence([fila]), table: tanque }).effect).toBe(
      RandomEffectType.Evade,
    )
  })

  it('la secuencia solo necesita nextIndex: ni normal cruda ni semilla', () => {
    // El tipo de `ScriptedSequence` solo implementa `nextIndex`. Que compile y
    // funcione demuestra que HU-25 no depende de nada mas del puerto.
    const onlyIndex: RandomSequencePort = { nextIndex: () => RandomIndex.create(1) }

    expect(useCase.execute({ sequence: onlyIndex, table }).effect).toBe(RandomEffectType.Damage)
  })
})
