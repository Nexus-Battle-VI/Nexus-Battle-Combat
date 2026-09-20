import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { ResolveRandomEffect } from '../../src/application/use-cases/ResolveRandomEffect'
import { baseEffectTableFor } from '../../src/domain/random-effects/BaseEffectProfiles'
import { type EffectControlTable } from '../../src/domain/random-effects/EffectControlTable'
import { ProbabilityModifier } from '../../src/domain/random-effects/ProbabilityModifier'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'

/**
 * Integracion HU-24 -> HU-25 (Application / composicion).
 *
 *   RandomSequencePort.nextIndex()  ->  RandomIndex  ->  EffectControlTable.resolve()
 *
 * La semilla 3.000.000 se usa como FIXTURE determinista (candidata del estudio
 * de HU-26), NO como politica de semilla: esa decision pertenece a la batalla y
 * a HU-26. Solo se consume `nextIndex()`; nunca la normal cruda.
 */
const SEED = RandomSeed.create(3_000_000)
const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
const resolveRandomEffect = new ResolveRandomEffect()

const D = RandomEffectType.Damage
const C = RandomEffectType.CriticalDamage
const E = RandomEffectType.Evade
const S = RandomEffectType.Escape
const N = RandomEffectType.NoDamage

const armasBase = (): EffectControlTable => baseEffectTableFor(HeroSubtype.GuerreroArmas)
const armasEquipado = (): EffectControlTable =>
  armasBase().withModifiers([ProbabilityModifier.ofBasisPoints(C, 600)])

const draw = (table: EffectControlTable, count: number): RandomEffectType[] => {
  const sequence = factory.create(SEED)

  return Array.from(
    { length: count },
    () => resolveRandomEffect.execute({ sequence, table }).effect,
  )
}

const proportions = (effects: readonly RandomEffectType[]): Record<string, number> => {
  const counts: Record<string, number> = {}

  for (const effect of effects) {
    counts[effect] = (counts[effect] ?? 0) + 1
  }

  return Object.fromEntries(
    Object.entries(counts).map(([effect, count]) => [effect, count / effects.length]),
  )
}

describe('Integracion HU-24 -> HU-25', () => {
  describe('golden (semilla 3.000.000, indices de HU-24 ya validados)', () => {
    it('los diez primeros efectos de un Guerrero Armas base', () => {
      // Indices de HU-24 con esta semilla: 2648, 3529, 3542, 7654, 7019, 4260,
      // 2553, 5830, 2324, 6027 (ver test/unit/randomness-golden.spec.ts).
      expect(draw(armasBase(), 10)).toEqual([D, D, D, N, N, D, D, N, D, N])
    })

    it('la misma semilla y la misma tabla reproducen exactamente la misma secuencia de efectos', () => {
      expect(draw(armasBase(), 500)).toEqual(draw(armasBase(), 500))
    })

    it('un indice puede resolver efectos distintos segun la tabla vigente (base vs equipada)', () => {
      const base = draw(armasBase(), 2_000)
      const equipped = draw(armasEquipado(), 2_000)

      // Mismos indices, tablas distintas: las filas 4801-5680 pasan de
      // evasion/escape/"no causar dano" a critico.
      expect(equipped).not.toEqual(base)
      expect(equipped.filter((effect) => effect === C).length).toBeGreaterThan(
        base.filter((effect) => effect === C).length,
      )
    })
  })

  describe('convergencia estadistica determinista (indice uniforme + tabla por filas)', () => {
    /**
     * 200.000 golpes con semilla fija: el resultado es SIEMPRE el mismo, asi que
     * no es flaky. Tolerancia absoluta de 0,5 puntos porcentuales: la
     * desviacion tipica maxima de una proporcion con n = 200.000 es 0,11
     * puntos (4,5 sigma), y el error observado con esta semilla es <= 0,13.
     * NO reemplaza el estudio de HU-26: solo demuestra que "indice uniforme +
     * filas" produce las proporciones funcionales de la tabla.
     */
    const SAMPLE = 200_000
    const TOLERANCE = 0.005

    it('Guerrero Armas base (Tabla 22): 60 / 5 / 3 / 2 / 30 %', () => {
      const observed = proportions(draw(armasBase(), SAMPLE))

      expect(Math.abs((observed[D] ?? 0) - 0.6)).toBeLessThan(TOLERANCE)
      expect(Math.abs((observed[C] ?? 0) - 0.05)).toBeLessThan(TOLERANCE)
      expect(Math.abs((observed[E] ?? 0) - 0.03)).toBeLessThan(TOLERANCE)
      expect(Math.abs((observed[S] ?? 0) - 0.02)).toBeLessThan(TOLERANCE)
      expect(Math.abs((observed[N] ?? 0) - 0.3)).toBeLessThan(TOLERANCE)
      expect(observed[RandomEffectType.Resist]).toBeUndefined()
    })

    it('Guerrero Armas con +6 % de critico (Tabla 23): 60 / 11 / 3 / 2 / 24 %', () => {
      const observed = proportions(draw(armasEquipado(), SAMPLE))

      expect(Math.abs((observed[D] ?? 0) - 0.6)).toBeLessThan(TOLERANCE)
      expect(Math.abs((observed[C] ?? 0) - 0.11)).toBeLessThan(TOLERANCE)
      expect(Math.abs((observed[E] ?? 0) - 0.03)).toBeLessThan(TOLERANCE)
      expect(Math.abs((observed[S] ?? 0) - 0.02)).toBeLessThan(TOLERANCE)
      expect(Math.abs((observed[N] ?? 0) - 0.24)).toBeLessThan(TOLERANCE)
    })

    it('las proporciones observadas son las de la TABLA de filas, no las de una normal directa (~72,6 % de dano)', () => {
      const observed = proportions(draw(armasBase(), SAMPLE))

      // Con la normal usada directamente como indice, "causar dano" (filas
      // 1-4800) recibiria ~72,6 %. Con el indice uniforme recibe ~60 %.
      expect(observed[D] ?? 0).toBeLessThan(0.65)
    })
  })

  describe('el motor no se expone', () => {
    it('el resultado de un golpe efectivo es solo efecto y magnitud', () => {
      const resolved = resolveRandomEffect.execute({
        sequence: factory.create(SEED),
        table: armasBase(),
      })

      expect(Object.keys(resolved).sort()).toEqual(['effect', 'magnitude'])
    })
  })
})
