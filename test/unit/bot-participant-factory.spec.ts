import { BotParticipantFactory } from '../../src/application/services/BotParticipantFactory'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type { BotCombatCatalogPort } from '../../src/application/ports/BotCombatCatalogPort'
import { scriptedRandom } from '../fixtures/battle'
import {
  botCatalogCandidates,
  equipment,
  offensiveHero,
  supportHero,
} from '../fixtures/combat-bot-candidates'

const catalog = (
  candidates = botCatalogCandidates(),
): BotCombatCatalogPort & { readonly calls: number[] } => {
  const calls: number[] = []

  return {
    calls,
    listBotCandidates: () => {
      calls.push(calls.length + 1)
      return Promise.resolve(candidates)
    },
  }
}

describe('BotParticipantFactory — HU-93.1', () => {
  it('selecciona uniformemente un heroe sobre orden canonico y conserva stats/abilities reales', async () => {
    const second = offensiveHero({
      productId: '10000000-0000-4000-8000-000000000009',
      sku: 'hero-second',
      baseAttack: { mode: 'FIXED', amount: 13 },
      baseDamage: { mode: 'FIXED', amount: 9 },
    })
    const random = scriptedRandom([1, 9999])
    const factory = new BotParticipantFactory(
      catalog(botCatalogCandidates({ heroes: [second, offensiveHero()] })),
      random,
    )

    const result = await factory.create()

    expect(random.bounds).toEqual([2, 10_000])
    expect(result.heroId).toBe(second.productId)
    expect(result.heroSubtype).toBe('GUERRERO_ARMAS')
    expect(result.profile).toMatchObject({
      heroId: second.productId,
      attack: 13,
      damage: { mode: 'FIXED', amount: 9 },
      maxPower: 10,
      abilities: [
        { abilityId: second.abilities[0], name: 'Golpe preciso 1' },
        { abilityId: second.abilities[1], name: 'Golpe preciso 3' },
        { abilityId: second.abilities[2], name: 'Golpe preciso 4' },
      ],
    })
    expect(result.profile).not.toHaveProperty('level')
  })

  it.each(['CHAMAN', 'MEDICO'] as const)(
    '%s conserva soporte puro: attack/damage null y habilidad no ofensiva',
    async (subtype) => {
      const hero = supportHero(subtype)
      const result = await new BotParticipantFactory(
        catalog(botCatalogCandidates({ heroes: [hero] })),
        scriptedRandom([0, 9999]),
      ).create()

      expect(result.profile.attack).toBeNull()
      expect(result.profile.damage).toBeNull()
      expect(result.profile.abilities?.[0]?.effects[0]?.kind).toBe('HEALING')
    },
  )

  it('falla cerrado antes de consumir RNG si CHAMAN/MEDICO referencia DAMAGE o REFLECT_DAMAGE', async () => {
    const hero = supportHero('CHAMAN')
    const baseline = botCatalogCandidates({ heroes: [hero] })
    const invalid = botCatalogCandidates({
      heroes: [hero],
      abilities: baseline.abilities.map((ability) =>
        ability.productId === hero.abilities[0]
          ? {
              productId: ability.productId,
              sku: 'ability-invalid',
              name: 'No debe existir',
              compatibleHeroSubtypes: ['CHAMAN'],
              powerCostMode: 'FIXED' as const,
              powerCost: 1,
              chargeTurns: 1,
              effects: [
                {
                  kind: 'REFLECT_DAMAGE' as const,
                  target: 'SELF' as const,
                  magnitude: { mode: 'PERCENTAGE' as const, basisPoints: 500 },
                  stackable: false as const,
                },
              ],
            }
          : ability,
      ),
    })
    const random = scriptedRandom([])

    await expect(
      new BotParticipantFactory(catalog(invalid), random).create(),
    ).rejects.toBeInstanceOf(UpstreamServiceError)
    expect(random.bounds).toEqual([])
  })

  it('llena 2 armas, cada armor slot y 2 items sin duplicar ni usar incompatibles', async () => {
    const armorSlots = ['HEAD', 'CHEST', 'GLOVES', 'BRACERS', 'PANTS', 'SHOES'] as const
    const compatible = [
      equipment(1),
      equipment(2),
      ...armorSlots.map((slot, index) => equipment(10 + index, { type: 'ARMADURA', slot })),
      equipment(30, { type: 'ITEM' }),
      equipment(31, { type: 'ITEM' }),
    ]
    const incompatible = equipment(99, {
      compatibilityScope: 'SELECTED_SUBTYPES',
      compatibleHeroSubtypes: ['MEDICO'],
    })
    const random = scriptedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9999])
    const result = await new BotParticipantFactory(
      catalog(botCatalogCandidates({ equipment: [...compatible, incompatible] })),
      random,
    ).create()

    expect(result.loadout).toHaveLength(10)
    expect(new Set(result.loadout.map((entry) => entry.productId)).size).toBe(10)
    expect(result.loadout.map((entry) => entry.slot)).toEqual([
      'WEAPON_1',
      'WEAPON_2',
      'HELMET',
      'CHEST',
      'GLOVES',
      'BRACERS',
      'PANTS',
      'SHOES',
      'ITEM_1',
      'ITEM_2',
    ])
    expect(result.loadout.map((entry) => entry.productId)).not.toContain(incompatible.productId)
  })

  it('aplica solo modificadores permanentes SELF a stats y conserva todos los efectos activos', async () => {
    const sword = equipment(1, {
      effects: [
        {
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'ATTACK',
          operation: 'INCREASE',
          magnitude: { mode: 'FIXED', amount: 3 },
          stackable: false,
        },
        {
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'DEFENSE',
          operation: 'INCREASE',
          magnitude: { mode: 'FIXED', amount: 99 },
          durationTurns: 2,
          stackable: false,
        },
      ],
    })
    const result = await new BotParticipantFactory(
      catalog(botCatalogCandidates({ equipment: [sword] })),
      scriptedRandom([0, 0, 9999]),
    ).create()

    expect(result.profile.attack).toBe(10)
    expect(result.profile.defense).toBe(8)
    expect(result.profile.activeEffects).toMatchObject([
      { sourceProductId: sword.productId, appliedToStats: true },
      { sourceProductId: sword.productId, appliedToStats: false, durationTurns: 2 },
    ])
  })

  it.each([
    [499, true],
    [500, false],
  ] as const)('roll %i respeta frontera exacta 5%%', async (roll, expectedEpic) => {
    const result = await new BotParticipantFactory(
      catalog(
        botCatalogCandidates({
          epics: [
            {
              productId: '40000000-0000-4000-8000-000000000001',
              sku: 'epic-one',
              name: 'Epica Uno',
              compatibleHeroSubtype: 'GUERRERO_ARMAS',
              specificEffects: [
                {
                  kind: 'DAMAGE',
                  target: 'OPPONENT',
                  magnitude: { mode: 'FIXED', amount: 7 },
                  stackable: false,
                },
              ],
              powerCost: 0,
              cooldownTurns: 2,
            },
          ],
        }),
      ),
      scriptedRandom([0, roll, ...(expectedEpic ? [0] : [])]),
    ).create()

    expect(result.profile.epic !== undefined).toBe(expectedEpic)
  })

  it('roll positivo sin epica compatible no fabrica una ni falla', async () => {
    const result = await new BotParticipantFactory(
      catalog(
        botCatalogCandidates({
          epics: [
            {
              productId: '40000000-0000-4000-8000-000000000001',
              sku: 'epic-medico',
              name: 'Epica Medico',
              compatibleHeroSubtype: 'MEDICO',
              specificEffects: [
                {
                  kind: 'HEALING',
                  target: 'SELF',
                  magnitude: { mode: 'FIXED', amount: 7 },
                  stackable: false,
                },
              ],
              powerCost: 0,
              cooldownTurns: 2,
            },
          ],
        }),
      ),
      scriptedRandom([0, 0]),
    ).create()

    expect(result.profile.epic).toBeUndefined()
  })
})
