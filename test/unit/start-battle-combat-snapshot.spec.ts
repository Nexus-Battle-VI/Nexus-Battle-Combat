import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type { EquippedHero } from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import { combatProfileFrom } from '../../src/application/services/CombatProfileFactory'
import { BotParticipantFactory } from '../../src/application/services/BotParticipantFactory'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import { StartBattle } from '../../src/application/use-cases/StartBattle'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { equippedHeroFixture, golpeDeDefensaEpic } from '../fixtures/equipped-hero'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'
import { botCatalogCandidates } from '../fixtures/combat-bot-candidates'
import {
  ROOM_ID,
  clock,
  heroesPort,
  preparingRoom,
  recordingPublisher,
  scriptedRandom,
  scriptedSequence,
} from '../fixtures/battle'
import { indexForEffect, indexForFace } from '../fixtures/basic-attack'

/**
 * Snapshot de combate al iniciar (HU-18): se construye con la MISMA respuesta de
 * Player-Inventory que ya revalida HU-16, se congela y no se vuelve a consultar.
 */
const hero = (playerId: string, overrides: Partial<EquippedHero> = {}): EquippedHero =>
  equippedHeroFixture({
    playerId,
    heroId: `hero-${playerId}`,
    loadoutVersion: 3,
    activeEffects: [],
    effectiveStats: {
      power: 10,
      health: 44,
      defense: 11,
      attack: 10,
      damage: { mode: 'DICE', count: 1, sides: 6 },
      healing: null,
    },
    ...overrides,
  })

const start = async (
  options: Parameters<typeof preparingRoom>[0] = {},
  heroes = heroesPort({}, (playerId) => hero(playerId)),
) => {
  const repo = new InMemoryBattleRoomRepository()

  await repo.save(preparingRoom(options), 0)

  const random = scriptedRandom(
    (options.aiInTeamA ?? 0) + (options.aiInTeamB ?? 0) > 0 ? [0, 9999, 0] : [0],
  )
  const useCase = new StartBattle(
    repo,
    clock,
    heroes,
    random,
    recordingPublisher(),
    recordingBattleCommitments(),
    null,
    null,
    null,
    null,
    new BotParticipantFactory(
      { listBotCandidates: () => Promise.resolve(botCatalogCandidates()) },
      random,
    ),
  )
  const dto = await useCase.execute(ROOM_ID, 'a1')

  return { repo, heroes, dto, useCase }
}

describe('StartBattle — snapshot de combate (HU-18)', () => {
  it('la Vida inicial de cada participante es effectiveStats.health, con Vida actual = maxima', async () => {
    const { dto } = await start(
      {},
      heroesPort({}, (playerId) =>
        hero(playerId, {
          effectiveStats: {
            power: 10,
            health: playerId === 'a1' ? 44 : 36,
            defense: 11,
            attack: 10,
            damage: { mode: 'DICE', count: 1, sides: 6 },
            healing: null,
          },
        }),
      ),
    )

    // HU-19 amplia la vista con `power` y `skills`: aqui solo importa la Vida.
    expect(dto.battle?.combatants).toMatchObject([
      { teamLabel: 'A', seat: 0, health: { current: 44, max: 44 } },
      { teamLabel: 'B', seat: 0, health: { current: 36, max: 36 } },
    ])
  })

  it('NO hay una segunda llamada a Player-Inventory: una por humano, como antes de HU-18', async () => {
    const { heroes } = await start()

    expect(heroes.calls.sort()).toEqual(['a1', 'b1'])
  })

  it('Player-Inventory NO se consulta por golpe: tras varios ataques las llamadas siguen siendo las del inicio', async () => {
    const { repo, heroes } = await start()
    const attack = new ExecuteBasicAttack(
      repo,
      clock,
      scriptedSequence([
        indexForFace(5, 6),
        indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
        indexForFace(4, 6),
        indexForFace(5, 6),
        indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
        indexForFace(3, 6),
      ]),
      new ChannelLock(),
    )
    const before = heroes.calls.length

    await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'a1',
      commandId: 'c1',
      target: { teamLabel: 'B', seat: 0 },
    })
    await attack.execute({
      roomId: ROOM_ID,
      requesterId: 'b1',
      commandId: 'c2',
      target: { teamLabel: 'A', seat: 0 },
    })

    expect(heroes.calls).toHaveLength(before)
  })

  it('las estadisticas se CONGELAN: cambiar el equipo en Player-Inventory despues de iniciar no modifica la batalla', async () => {
    const stronger: EquippedHero[] = []
    const heroes = heroesPort({}, (playerId) => hero(playerId))
    const { repo } = await start({}, heroes)

    // Despues de iniciar, Player-Inventory ahora devolveria un heroe mucho mas fuerte.
    stronger.push(
      hero('a1', {
        effectiveStats: {
          power: 99,
          health: 999,
          defense: 99,
          attack: 99,
          damage: { mode: 'DICE', count: 9, sides: 20 },
          healing: null,
        },
      }),
    )
    const room = await repo.findById(ROOM_ID)
    const profile = room?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.profile

    expect(stronger[0]?.effectiveStats.health).toBe(999)
    expect(profile).toMatchObject({ maxHealth: 44, attack: 10, defense: 11 })
    expect(profile?.damage).toEqual({ mode: 'DICE', count: 1, sides: 6 })
  })

  it('el snapshot es un modelo LOCAL MINIMO: no copia inventario, nombre, referencia ni fecha (solo el Poder MAXIMO, el nivel y las habilidades de HU-19)', async () => {
    const { repo } = await start()
    const profile = (await repo.findById(ROOM_ID))?.battle?.combatantFor({
      teamLabel: 'A',
      seat: 0,
    })?.profile

    expect(Object.keys(profile ?? {}).sort()).toEqual([
      'abilities',
      'activeEffects',
      'attack',
      'damage',
      'defense',
      'heroId',
      'level',
      'maxHealth',
      'maxPower',
      'subtype',
    ])
    // HU-08 (CA-06): el nivel se congela con el perfil (multiplica el resultado del Dano).
    expect(profile?.level).toBe(1)
    expect(JSON.stringify(profile)).not.toMatch(/selectedAt|baseStats|blockers|loadout|sourceSlot/i)
    // La `reference` (alias) de una habilidad es trazabilidad de Player-Inventory: no se congela.
    expect(JSON.stringify(profile?.abilities)).not.toMatch(/reference|golpe-con-escudo/)
  })

  it('combatProfileFrom copia solo los efectos que HU-20 necesita y no comparte referencias con el DTO upstream', () => {
    const source = hero('a1', {
      activeEffects: [
        {
          sourceProductId: 'p1',
          sourceProductReference: 'espada',
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'CRITICAL_CHANCE',
          operation: 'INCREASE',
          magnitude: { mode: 'PERCENTAGE', basisPoints: 300 },
          hasActivationCondition: false,
          appliedToStats: false,
        },
      ],
    })
    const profile = combatProfileFrom(source)

    expect(profile.activeEffects[0]).toEqual(source.activeEffects[0])
    expect(profile.activeEffects[0]).not.toBe(source.activeEffects[0])
    expect(profile.damage).not.toBe(source.effectiveStats.damage)
  })

  it('un participante AI recibe perfil autoritativo de Catalog, sin consultar Player-Inventory', async () => {
    const { dto, heroes } = await start(
      { mode: 'PVE', teamSizes: [1, 1], aiInTeamB: 1 },
      heroesPort({}, (playerId) => hero(playerId)),
    )

    expect(dto.battle?.combatants[0]).toMatchObject({
      teamLabel: 'A',
      seat: 0,
      health: { current: 44, max: 44 },
    })
    expect(dto.battle?.combatants[1]).toMatchObject({
      teamLabel: 'B',
      seat: 0,
      health: { current: 40, max: 40 },
      power: { current: 10, max: 10 },
      skills: [{ abilityId: '20000000-0000-4000-8000-000000000001' }],
    })
    expect(heroes.calls).toEqual(['a1'])
  })

  it.each([
    ['Vida decimal', { health: 44.5 }],
    ['Vida negativa', { health: -1 }],
    ['Defensa decimal', { defense: 3.5 }],
    ['Ataque decimal', { attack: 10.5 }],
  ])(
    'un dato upstream mal formado (%s) es un fallo del servicio, no se corrige en silencio',
    async (_name, patch) => {
      const heroes = heroesPort({}, (playerId) =>
        hero(playerId, {
          effectiveStats: {
            power: 10,
            health: 44,
            defense: 11,
            attack: 10,
            damage: { mode: 'DICE', count: 1, sides: 6 },
            healing: null,
            ...patch,
          },
        }),
      )
      const repo = new InMemoryBattleRoomRepository()

      await repo.save(preparingRoom(), 0)

      const useCase = new StartBattle(
        repo,
        clock,
        heroes,
        scriptedRandom([0]),
        recordingPublisher(),
        recordingBattleCommitments(),
      )

      await expect(useCase.execute(ROOM_ID, 'a1')).rejects.toBeInstanceOf(UpstreamServiceError)
      // Sin cola, sin evento y la sala sigue PREPARING.
      expect((await repo.findById(ROOM_ID))?.status).toBe('PREPARING')
    },
  )

  it('el evento battleStarted ya lleva la Vida inicial en su vista (los clientes la reciben al empezar)', async () => {
    const { repo } = await start()
    const room = await repo.findById(ROOM_ID)
    const payload = room?.events[0]?.payload as unknown as { battle: { combatants: unknown[] } }

    expect(payload.battle.combatants).toHaveLength(2)
  })
})

describe('StartBattle — epica equipada congelada en el snapshot (HU-31, contrato hu-31-equipped-epic-v1)', () => {
  it('T-C-01/T-C-02: subtipo coincidente -> el snapshot congela base y especifico ya resueltos', async () => {
    const { repo } = await start(
      {},
      heroesPort({}, (playerId) => hero(playerId, { epic: golpeDeDefensaEpic })),
    )
    const profile = (await repo.findById(ROOM_ID))?.battle?.combatantFor({
      teamLabel: 'A',
      seat: 0,
    })?.profile

    expect(profile?.epic?.applied.baseApplied).not.toBeNull()
    expect(profile?.epic?.applied.additionalApplied.length).toBeGreaterThan(0)
  })

  it('T-C-03: subtipo NO coincidente -> el snapshot congela solo el efecto base', async () => {
    const { repo } = await start(
      {},
      heroesPort({}, (playerId) =>
        hero(playerId, {
          subtype: 'GUERRERO_TANQUE',
          epic: {
            ...golpeDeDefensaEpic,
            applied: { baseApplied: golpeDeDefensaEpic.baseEffect, additionalApplied: [] },
          },
        }),
      ),
    )
    const profile = (await repo.findById(ROOM_ID))?.battle?.combatantFor({
      teamLabel: 'A',
      seat: 0,
    })?.profile

    expect(profile?.epic?.applied.baseApplied).not.toBeNull()
    expect(profile?.epic?.applied.additionalApplied).toEqual([])
  })

  it('T-C-04: batalla sin epica equipada -> comportamiento anterior intacto, sin la clave epic', async () => {
    const { repo } = await start()
    const profile = (await repo.findById(ROOM_ID))?.battle?.combatantFor({
      teamLabel: 'A',
      seat: 0,
    })?.profile

    expect('epic' in (profile ?? {})).toBe(false)
  })

  it('T-C-04 bis: la epica se CONGELA -- Player-Inventory no se vuelve a consultar tras iniciar, aunque el heroe tenga epica', async () => {
    const heroes = heroesPort({}, (playerId) => hero(playerId, { epic: golpeDeDefensaEpic }))
    const { repo } = await start({}, heroes)
    const callsAfterStart = heroes.calls.length

    // Leer la sala de nuevo, mas tarde, no debe disparar una segunda consulta:
    // el perfil con la epica ya esta congelado en el documento persistido.
    const room = await repo.findById(ROOM_ID)
    const profile = room?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.profile

    expect(heroes.calls).toHaveLength(callsAfterStart)
    expect(profile?.epic?.epicReference).toBe(golpeDeDefensaEpic.epicReference)
  })

  it('T-C-05/T-C-06: team battle -- cada participante conserva su propia epica, incluso con la misma definicion', async () => {
    const epicoA = golpeDeDefensaEpic
    const epicoB = {
      ...golpeDeDefensaEpic,
      applied: { baseApplied: golpeDeDefensaEpic.baseEffect, additionalApplied: [] },
    }
    const heroes = heroesPort(
      {
        a1: hero('a1', { epic: epicoA }),
        a2: hero('a2', {}),
        b1: hero('b1', { subtype: 'GUERRERO_TANQUE', epic: epicoB }),
        b2: hero('b2', { epic: epicoA }),
      },
      (playerId) => hero(playerId),
    )
    const repo = new InMemoryBattleRoomRepository()
    await repo.save(preparingRoom({ teamSizes: [2, 2] }), 0)
    const useCase = new StartBattle(
      repo,
      clock,
      heroes,
      // 4 participantes: el barajado Fisher-Yates consume exactamente 3 selecciones.
      scriptedRandom([0, 0, 0]),
      recordingPublisher(),
      recordingBattleCommitments(),
    )
    await useCase.execute(ROOM_ID, 'a1')
    const room = await repo.findById(ROOM_ID)

    const a1Profile = room?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.profile
    const a2Profile = room?.battle?.combatantFor({ teamLabel: 'A', seat: 1 })?.profile
    const b1Profile = room?.battle?.combatantFor({ teamLabel: 'B', seat: 0 })?.profile
    const b2Profile = room?.battle?.combatantFor({ teamLabel: 'B', seat: 1 })?.profile

    expect(a1Profile?.epic?.applied.additionalApplied.length).toBeGreaterThan(0)
    expect('epic' in (a2Profile ?? {})).toBe(false)
    expect(b1Profile?.epic?.applied.additionalApplied).toEqual([])
    expect(b2Profile?.epic?.applied.additionalApplied.length).toBeGreaterThan(0)
    // Misma definicion de epica (A1 y B2), estados independientes por participante.
    expect(a1Profile?.epic).not.toBe(b2Profile?.epic)
    expect(a1Profile?.epic).toEqual(b2Profile?.epic)
  })
})
