import { PlayerInventoryHttpClient } from '../../src/adapters/outbound/http/PlayerInventoryHttpClient'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  EquippedHero,
  EquippedHeroEffect,
  EquippedHeroStats,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import { prepareAttack } from '../../src/application/use-cases/PrepareAttack'
import { ResolveAttack, type AttackResolution } from '../../src/application/use-cases/ResolveAttack'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import type { Logger } from '../../src/infrastructure/observability/logger'
import { equippedHeroContractBody, equippedHeroFixture } from '../fixtures/equipped-hero'

/**
 * Integracion HU-24 -> HU-25 -> HU-20 (composicion, sin HTTP):
 *
 *   heroes (contrato de Player-Inventory)  ->  prepareAttack
 *   RandomSequencePort (MT19937 + Box-Muller + CDF)  ->  ResolveAttack
 *
 * La semilla 3.000.000 se usa como FIXTURE determinista (la semilla ratificada por
 * el estudio de HU-26), NO como politica de semilla por batalla. Sus primeros diez
 * indices, ya validados en `randomness-golden.spec.ts`, son:
 *
 *   2648, 3529, 3542, 7654, 7019, 4260, 2553, 5830, 2324, 6027
 */
const SEED = RandomSeed.create(3_000_000)
const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
const resolveAttack = new ResolveAttack()

const D = RandomEffectType.Damage
const N = RandomEffectType.NoDamage

const stats = (attack: number | null, defense: number): EquippedHeroStats => ({
  power: 8,
  health: 40,
  defense,
  attack,
  damage: { mode: 'DICE', count: 1, sides: 4 },
  healing: null,
})

/** Heroe SIN equipo: sus estadisticas efectivas son las base. */
const bare = (
  subtype: string,
  attack: number,
  defense: number,
  activeEffects: readonly EquippedHeroEffect[] = [],
): EquippedHero =>
  equippedHeroFixture({
    subtype,
    baseStats: stats(attack, defense),
    effectiveStats: stats(attack, defense),
    activeEffects,
  })

const attacksOf = (
  attacker: EquippedHero,
  target: EquippedHero,
  count: number,
): AttackResolution[] => {
  const sequence = factory.create(SEED)
  const prepared = prepareAttack(attacker, target)

  return Array.from({ length: count }, () => resolveAttack.execute({ ...prepared, sequence }))
}

describe('Integracion HU-24 -> HU-25 -> HU-20: golden con la semilla 3.000.000', () => {
  const armas = bare('GUERRERO_ARMAS', 10, 11)
  const tanque = bare('GUERRERO_TANQUE', 10, 11)

  it('Armas (10 + 1d6) contra Tanque (Defensa 11): los cinco primeros golpes, derivados a mano de los indices', () => {
    // golpe 1: dado con 2648 -> cara 2 -> 12 > 11 efectivo; efecto con 3529 -> DAMAGE
    // golpe 2: dado con 3542 -> cara 3 -> 13 > 11 efectivo; efecto con 7654 -> NO_DAMAGE
    // golpe 3: dado con 7019 -> cara 6 -> 16 > 11 efectivo; efecto con 4260 -> DAMAGE
    // golpe 4: dado con 2553 -> cara 2 -> 12 > 11 efectivo; efecto con 5830 -> NO_DAMAGE
    // golpe 5: dado con 2324 -> cara 2 -> 12 > 11 efectivo; efecto con 6027 -> NO_DAMAGE
    const results = attacksOf(armas, tanque, 5)

    expect(results.map(({ attackRoll }) => attackRoll)).toEqual([2, 3, 6, 2, 2])
    expect(results.map(({ attackValue }) => attackValue)).toEqual([12, 13, 16, 12, 12])
    expect(results.map(({ effective }) => effective)).toEqual([true, true, true, true, true])
    expect(results.map(({ effect }) => effect?.effect)).toEqual([D, N, D, N, N])
    expect(results.map(({ effect }) => effect?.percent)).toEqual([100, 0, 100, 0, 0])
  })

  it('la misma semilla y los mismos heroes reproducen exactamente la misma serie de golpes', () => {
    expect(attacksOf(armas, tanque, 200)).toEqual(attacksOf(armas, tanque, 200))
  })

  it('con una Defensa mayor los primeros golpes fallan y SOLO el efectivo consume el indice del efecto', () => {
    // Defensa 14: 12 no, 13 no, 13 no, 16 SI (dado con 7654 -> cara 6); efecto con 7019 -> NO_DAMAGE.
    const blindado = bare('GUERRERO_TANQUE', 10, 14)
    const sequence = factory.create(SEED)
    const prepared = prepareAttack(armas, blindado)

    const results = Array.from({ length: 4 }, () =>
      resolveAttack.execute({ ...prepared, sequence }),
    )

    expect(results.map(({ attackValue }) => attackValue)).toEqual([12, 13, 13, 16])
    expect(results.map(({ effective }) => effective)).toEqual([false, false, false, true])
    expect(results.map(({ effect }) => effect?.effect ?? null)).toEqual([null, null, null, N])

    // Se consumieron 5 indices (4 dados + 1 efecto): el siguiente es el sexto, 4260.
    expect(sequence.nextIndex().value).toBe(4260)
  })

  it('el equipo cambia el resultado: la espada (+3 al Ataque) vuelve efectivos golpes que sin ella fallaban', () => {
    const espada = equippedHeroFixture({
      subtype: 'GUERRERO_ARMAS',
      baseStats: stats(10, 8),
      effectiveStats: stats(13, 8),
      activeEffects: [],
    })
    const contraBlindado = bare('GUERRERO_TANQUE', 10, 14)

    const sinEspada = attacksOf(armas, contraBlindado, 10).filter(({ effective }) => effective)
    const conEspada = attacksOf(espada, contraBlindado, 10).filter(({ effective }) => effective)

    expect(conEspada.length).toBeGreaterThan(sinEspada.length)
  })
})

describe('Integracion HU-24 -> HU-25 -> HU-20: la probabilidad de acierto sale del dado (Tabla 6)', () => {
  const SAMPLES = 100_000
  const hitRate = (attacker: EquippedHero, target: EquippedHero): number =>
    attacksOf(attacker, target, SAMPLES).filter(({ effective }) => effective).length / SAMPLES

  it('Armas (10 + 1d6) contra Defensa 11 acierta con cara >= 2: ~ 83,3 %', () => {
    // P = 1 - 1334/8000 (la cara 1 recibe 1334 filas) = 0,83325.
    expect(hitRate(bare('GUERRERO_ARMAS', 10, 11), bare('GUERRERO_TANQUE', 10, 11))).toBeCloseTo(
      0.83325,
      2,
    )
  })

  it('Mago Fuego (10 + 1d8) contra Defensa 14 acierta con cara >= 5: 50 %', () => {
    expect(hitRate(bare('MAGO_FUEGO', 10, 10), bare('GUERRERO_TANQUE', 10, 14))).toBeCloseTo(0.5, 2)
  })

  it('Picaro Machete (10 + 1d10) contra Defensa 15 acierta con cara >= 6: 50 %', () => {
    expect(hitRate(bare('PICARO_MACHETE', 10, 8), bare('GUERRERO_TANQUE', 10, 15))).toBeCloseTo(
      0.5,
      2,
    )
  })

  it('con Defensa 10 un ataque de 10 + 1dN SIEMPRE es efectivo (el minimo es 11)', () => {
    expect(hitRate(bare('MAGO_HIELO', 10, 10), bare('MAGO_FUEGO', 10, 10))).toBe(1)
  })

  it('con Defensa 16 un Guerrero (maximo 10 + 6) NUNCA es efectivo', () => {
    expect(hitRate(bare('GUERRERO_ARMAS', 10, 11), bare('GUERRERO_TANQUE', 10, 16))).toBe(0)
  })

  it('sin dado de Ataque un heroe con Ataque 10 no puede superar una Defensa 11 (lo que el documento evita con el dado)', () => {
    const sequence = factory.create(SEED)
    const prepared = prepareAttack(bare('GUERRERO_ARMAS', 10, 11), bare('GUERRERO_TANQUE', 10, 11))

    const flat = resolveAttack.execute({
      attack: { base: prepared.attack.base, dice: null },
      defenseValue: prepared.defenseValue,
      table: prepared.table,
      sequence,
    })

    expect(flat.effective).toBe(false)
  })
})

describe('Integracion HU-24 -> HU-25 -> HU-20: los efectos de los golpes efectivos siguen la tabla', () => {
  it('Mago Fuego contra Defensa 10 (siempre efectivo): ~ 70 / 5 / 5 / 20 % (Tabla 21)', () => {
    const results = attacksOf(bare('MAGO_FUEGO', 10, 10), bare('MAGO_HIELO', 10, 10), 100_000)
    const share = (effect: RandomEffectType): number =>
      results.filter((result) => result.effect?.effect === effect).length / results.length

    expect(results.every(({ effective }) => effective)).toBe(true)
    expect(share(D)).toBeCloseTo(0.7, 2)
    expect(share(RandomEffectType.CriticalDamage)).toBeCloseTo(0.05, 2)
    expect(share(RandomEffectType.Resist)).toBeCloseTo(0.05, 2)
    expect(share(N)).toBeCloseTo(0.2, 2)
  })

  it('el critico se materializa en 120..180 y recorre todo el intervalo', () => {
    const results = attacksOf(bare('PICARO_VENENO', 10, 8), bare('MAGO_HIELO', 10, 8), 100_000)
    const percents = results
      .filter(({ effect }) => effect?.effect === RandomEffectType.CriticalDamage)
      .map(({ effect }) => effect?.percent ?? 0)

    expect(percents.length).toBeGreaterThan(9_000) // Veneno: ~10 % de critico
    expect(Math.min(...percents)).toBeGreaterThanOrEqual(120)
    expect(Math.max(...percents)).toBeLessThanOrEqual(180)
    expect(new Set(percents).size).toBeGreaterThan(55) // casi los 61 porcentajes enteros
  })
})

describe('Integracion contrato Player-Inventory -> HU-25 -> HU-20 (JSON real de ambos heroes)', () => {
  const clock: ClockPort = { now: () => new Date('2026-09-19T10:00:00.000Z') }
  const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }

  const clientFor = (bodies: Readonly<Record<string, unknown>>): PlayerInventoryHttpClient =>
    new PlayerInventoryHttpClient({
      baseUrl: 'https://player-inventory.internal',
      callerService: 'combat',
      secret: 'secreto-compartido-de-pruebas',
      clock,
      logger: silentLogger,
      fetchImpl: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const playerId = Object.keys(bodies).find((id) => url.includes(`/players/${id}/`))

        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve(playerId === undefined ? null : bodies[playerId]),
        } as unknown as Response)
      },
    })

  it('el JSON del atacante (espada +3 Ataque, +3 % critico) y el del objetivo se convierten en un golpe resuelto', async () => {
    const client = clientFor({
      'jugador-1': equippedHeroContractBody({ playerId: 'jugador-1' }),
      'jugador-2': equippedHeroContractBody({
        playerId: 'jugador-2',
        subtype: 'GUERRERO_TANQUE',
        reference: 'guerrero-tanque',
        baseStats: {
          power: 10,
          health: 44,
          defense: 11,
          attack: 10,
          damage: { mode: 'DICE', count: 1, sides: 4 },
          healing: null,
        },
        effectiveStats: {
          power: 10,
          health: 44,
          defense: 13,
          attack: 10,
          damage: { mode: 'DICE', count: 1, sides: 4 },
          healing: null,
        },
        activeEffects: [],
      }),
    })

    const attacker = await client.getEquippedHero('jugador-1')
    const target = await client.getEquippedHero('jugador-2')

    if (attacker === null || target === null) {
      throw new Error('Los heroes de prueba deberian existir.')
    }

    const prepared = prepareAttack(attacker, target)

    // CA-02: Ataque efectivo 13 (10 base + 3 de la espada), sin sumar dos veces.
    expect(prepared.attack).toEqual({ base: 13, dice: { count: 1, sides: 6 } })
    // CA-03: Defensa efectiva 13 (11 base + 2 de armadura).
    expect(prepared.defenseValue).toBe(13)
    // +3 % de critico del atacante: 400 -> 640 filas.
    expect(prepared.table.rowsOf(RandomEffectType.CriticalDamage)).toBe(640)

    // 13 + cara (1..6) supera 13 solo con cara >= 1: SIEMPRE efectivo; con los indices
    // 2648 (cara 2 -> 15) y 3529 (DAMAGE) el golpe es efectivo con DAMAGE al 100 %.
    const result = resolveAttack.execute({ ...prepared, sequence: factory.create(SEED) })

    expect(result).toMatchObject({
      attackBase: 13,
      attackRoll: 2,
      attackValue: 15,
      defenseValue: 13,
      effective: true,
    })
    expect(result.effect).toMatchObject({ effect: D, percent: 100 })
  })

  it('un atacante sanador llega como Ataque null y se rechaza de forma explicita', async () => {
    const client = clientFor({
      'sanador-1': equippedHeroContractBody({
        playerId: 'sanador-1',
        subtype: 'CHAMAN',
        reference: 'chaman',
        baseStats: {
          power: 10,
          health: 28,
          defense: 4,
          attack: null,
          damage: null,
          healing: { mode: 'DICE', count: 1, sides: 6 },
        },
        effectiveStats: {
          power: 10,
          health: 28,
          defense: 4,
          attack: null,
          damage: null,
          healing: { mode: 'DICE', count: 1, sides: 6 },
        },
        activeEffects: [],
      }),
      'jugador-2': equippedHeroContractBody({ playerId: 'jugador-2' }),
    })

    const healer = await client.getEquippedHero('sanador-1')
    const target = await client.getEquippedHero('jugador-2')

    if (healer === null || target === null) {
      throw new Error('Los heroes de prueba deberian existir.')
    }

    expect(() => prepareAttack(healer, target)).toThrow(/no tiene un valor de Ataque numerico/)
  })
})
