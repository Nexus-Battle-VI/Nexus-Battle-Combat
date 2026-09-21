import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { createBoundedRandom } from '../../src/application/services/BoundedRandom'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../src/application/errors/ApplicationError'
import { PrecombatEligibilityBlockedError } from '../../src/application/errors/PrecombatEligibilityError'
import {
  PlayerWithoutEquippedHeroError,
  UpstreamServiceError,
} from '../../src/application/errors/UpstreamErrors'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import {
  HERO_CHANGED_SINCE_JOIN,
  HERO_LOADOUT_CHANGED,
  StartBattle,
} from '../../src/application/use-cases/StartBattle'
import { RoomNotStartableError } from '../../src/domain/errors/BattleErrors'
import { BattleRoomStatus } from '../../src/domain/value-objects/BattleRoomStatus'
import type { BoundedRandom } from '../../src/domain/policies/TurnOrderPolicy'
import { equippedHeroFixture, equippedProductNotOwnedBlocker } from '../fixtures/equipped-hero'
import {
  NOW,
  ROOM_ID,
  clock,
  heroesPort,
  loggingRepository,
  preparingRoom,
  recordingPublisher,
  scriptedRandom,
  scriptedSequence,
} from '../fixtures/battle'

const seed = async (repo: BattleRoomRepositoryPort, options = {}): Promise<void> => {
  await repo.save(preparingRoom(options), 0)
}

const build = (
  repo: BattleRoomRepositoryPort,
  overrides: {
    heroes?: ReturnType<typeof heroesPort>
    random?: BoundedRandom
    publisher?: ReturnType<typeof recordingPublisher>
  } = {},
): {
  useCase: StartBattle
  heroes: ReturnType<typeof heroesPort>
  publisher: ReturnType<typeof recordingPublisher>
} => {
  const heroes = overrides.heroes ?? heroesPort()
  const publisher = overrides.publisher ?? recordingPublisher()

  return {
    useCase: new StartBattle(
      repo,
      clock,
      heroes,
      overrides.random ?? scriptedRandom([0]),
      publisher,
    ),
    heroes,
    publisher,
  }
}

describe('StartBattle — sala preparada -> batalla con cola generada (HU-17)', () => {
  it('1v1: crea UNA cola de dos participantes, IN_BATTLE, battleStarted seq 1 y turno activo en la posicion 0', async () => {
    const repo = new InMemoryBattleRoomRepository()

    await seed(repo)
    const { useCase, publisher } = build(repo, { random: scriptedRandom([1]) })

    const dto = await useCase.execute(ROOM_ID, 'a1')

    expect(dto.status).toBe('IN_BATTLE')
    expect(dto.battle?.turnOrder.map((entry) => entry.playerId)).toEqual(['b1', 'a1'])
    expect(dto.battle?.currentTurn.playerId).toBe('b1')
    expect(dto.battle?.turnsCompleted).toBe(0)
    expect(dto.lastSeq).toBe(1)
    expect(publisher.published).toHaveLength(1)
    expect(publisher.published[0]?.events.map((event) => event.type)).toEqual(['battleStarted'])
  })

  it('el sorteo lo decide la fuente HU-24: 0 inicia el equipo A, 1 inicia el B', async () => {
    const results: string[] = []

    for (const draw of [0, 1]) {
      const repo = new InMemoryBattleRoomRepository()

      await seed(repo)
      const dto = await build(repo, { random: scriptedRandom([draw]) }).useCase.execute(
        ROOM_ID,
        'a1',
      )

      results.push(dto.battle?.currentTurn.teamLabel ?? '')
    }

    expect(results).toEqual(['A', 'B'])
  })

  it('consume la fuente HU-24 real (RandomSequencePort): 1 indice para el equipo inicial en 1v1', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const sequence = scriptedSequence([2648])

    await seed(repo)
    // 2648 -> v = 2647 -> v mod 2 = 1 -> inicia el equipo B.
    const dto = await build(repo, { random: createBoundedRandom(sequence) }).useCase.execute(
      ROOM_ID,
      'b1',
    )

    expect(sequence.consumed()).toBe(1)
    expect(dto.battle?.currentTurn.teamLabel).toBe('B')
  })

  it('3v3: alternancia estricta B A B A B A y una unica cola publicada a los dos equipos', async () => {
    const repo = new InMemoryBattleRoomRepository()

    await seed(repo, { teamSizes: [3, 3] })
    const { useCase } = build(repo, { random: scriptedRandom([1, 2, 1, 2, 1]) })

    const dto = await useCase.execute(ROOM_ID, 'a2')

    expect(dto.battle?.turnOrder.map((entry) => entry.teamLabel)).toEqual([
      'B',
      'A',
      'B',
      'A',
      'B',
      'A',
    ])
    expect(new Set(dto.battle?.turnOrder.map((entry) => entry.playerId)).size).toBe(6)
  })

  it('PVE con AI: el AI entra en la cola sin heroe equipado que validar', async () => {
    const repo = new InMemoryBattleRoomRepository()

    await seed(repo, { teamSizes: [1, 1], aiInTeamB: 1 })
    const { useCase, heroes } = build(repo, { random: scriptedRandom([0]) })

    const dto = await useCase.execute(ROOM_ID, 'a1')

    expect(dto.battle?.turnOrder.map((entry) => entry.kind)).toEqual(['HUMAN', 'AI'])
    expect(heroes.calls).toEqual(['a1'])
    expect(dto.battle?.turnOrder[1]?.heroSubtype).toBeNull()
  })

  it('las estadisticas y el equipamiento NO influyen: heroes muy distintos, mismo orden con el mismo sorteo', async () => {
    const orders: string[][] = []

    for (const subtype of ['GUERRERO_TANQUE', 'MAGO_FUEGO']) {
      const repo = new InMemoryBattleRoomRepository()

      await seed(repo)
      const heroes = heroesPort({}, (playerId) =>
        equippedHeroFixture({
          playerId,
          heroId: `hero-${playerId}`,
          loadoutVersion: 3,
          subtype,
          baseStats: {
            power: 99,
            health: 999,
            defense: 99,
            attack: 99,
            damage: null,
            healing: null,
          },
        }),
      )
      const dto = await build(repo, { heroes, random: scriptedRandom([1]) }).useCase.execute(
        ROOM_ID,
        'a1',
      )

      orders.push(dto.battle?.turnOrder.map((entry) => entry.playerId ?? '') ?? [])
    }

    expect(orders[1]).toEqual(orders[0])
  })

  it('el subtipo del heroe se copia SOLO para presentacion (sin estadisticas)', async () => {
    const repo = new InMemoryBattleRoomRepository()

    await seed(repo)
    const dto = await build(repo, { random: scriptedRandom([0]) }).useCase.execute(ROOM_ID, 'a1')

    expect(dto.battle?.turnOrder[0]).toMatchObject({
      heroSubtype: 'GUERRERO_ARMAS',
      heroId: 'hero-a1',
    })
    expect(JSON.stringify(dto.battle)).not.toMatch(/attack|defense|power|health|loadout/i)
  })

  describe('validacion precombate (HU-16) al iniciar: si falla, NO hay cola ni evento', () => {
    const expectNoBattle = async (
      repo: InMemoryBattleRoomRepository,
      publisher: ReturnType<typeof recordingPublisher>,
    ): Promise<void> => {
      const room = await repo.findById(ROOM_ID)

      expect(room?.status).toBe(BattleRoomStatus.Preparing)
      expect(room?.battle).toBeNull()
      expect(room?.events).toEqual([])
      expect(publisher.published).toEqual([])
    }

    it('un participante ya no esta listo (readiness reenviada)', async () => {
      const repo = new InMemoryBattleRoomRepository()
      const publisher = recordingPublisher()

      await seed(repo)
      const heroes = heroesPort({
        b1: equippedHeroFixture({
          playerId: 'b1',
          heroId: 'hero-b1',
          loadoutVersion: 3,
          ready: false,
          blockers: [equippedProductNotOwnedBlocker],
        }),
      })
      const error: unknown = await build(repo, { heroes, publisher })
        .useCase.execute(ROOM_ID, 'a1')
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(PrecombatEligibilityBlockedError)
      expect((error as PrecombatEligibilityBlockedError).blockers).toEqual([
        equippedProductNotOwnedBlocker,
      ])
      await expectNoBattle(repo, publisher)
    })

    it('un participante cambio de heroe despues de unirse', async () => {
      const repo = new InMemoryBattleRoomRepository()
      const publisher = recordingPublisher()

      await seed(repo)
      const heroes = heroesPort({
        b1: equippedHeroFixture({ playerId: 'b1', heroId: 'otro-heroe', loadoutVersion: 3 }),
      })
      const error: unknown = await build(repo, { heroes, publisher })
        .useCase.execute(ROOM_ID, 'a1')
        .catch((caught: unknown) => caught)

      expect((error as PrecombatEligibilityBlockedError).blockers.map((b) => b.code)).toContain(
        HERO_CHANGED_SINCE_JOIN,
      )
      await expectNoBattle(repo, publisher)
    })

    it('el equipamiento cambio despues de aprobarse (version de loadout distinta)', async () => {
      const repo = new InMemoryBattleRoomRepository()
      const publisher = recordingPublisher()

      await seed(repo)
      const heroes = heroesPort({
        a1: equippedHeroFixture({ playerId: 'a1', heroId: 'hero-a1', loadoutVersion: 4 }),
      })
      const error: unknown = await build(repo, { heroes, publisher })
        .useCase.execute(ROOM_ID, 'b1')
        .catch((caught: unknown) => caught)

      expect((error as PrecombatEligibilityBlockedError).blockers.map((b) => b.code)).toContain(
        HERO_LOADOUT_CHANGED,
      )
      await expectNoBattle(repo, publisher)
    })

    it('un participante ya no tiene heroe equipado', async () => {
      const repo = new InMemoryBattleRoomRepository()
      const publisher = recordingPublisher()

      await seed(repo)
      const error: unknown = await build(repo, { heroes: heroesPort({ b1: null }), publisher })
        .useCase.execute(ROOM_ID, 'a1')
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(PlayerWithoutEquippedHeroError)
      await expectNoBattle(repo, publisher)
    })

    it('Chaman en 1v1: clase no permitida para el formato', async () => {
      const repo = new InMemoryBattleRoomRepository()
      const publisher = recordingPublisher()

      await seed(repo)
      const heroes = heroesPort({
        b1: equippedHeroFixture({
          playerId: 'b1',
          heroId: 'hero-b1',
          loadoutVersion: 3,
          subtype: 'CHAMAN',
        }),
      })

      await expect(
        build(repo, { heroes, publisher }).useCase.execute(ROOM_ID, 'a1'),
      ).rejects.toBeInstanceOf(PrecombatEligibilityBlockedError)
      await expectNoBattle(repo, publisher)
    })

    it('Player-Inventory caido: el error de la dependencia se propaga, sin cola', async () => {
      const repo = new InMemoryBattleRoomRepository()
      const publisher = recordingPublisher()

      await seed(repo)
      const heroes = {
        calls: [] as string[],
        getEquippedHero: () =>
          Promise.reject(new UpstreamServiceError('player-inventory', 'no_alcanzable')),
      }

      await expect(
        new StartBattle(repo, clock, heroes, scriptedRandom([0]), publisher).execute(ROOM_ID, 'a1'),
      ).rejects.toBeInstanceOf(UpstreamServiceError)
      await expectNoBattle(repo, publisher)
    })
  })

  describe('autorizacion y estado de la sala', () => {
    it('la sala no existe -> RoomNotFoundError', async () => {
      const { useCase } = build(new InMemoryBattleRoomRepository())

      await expect(useCase.execute(ROOM_ID, 'a1')).rejects.toBeInstanceOf(RoomNotFoundError)
    })

    it('quien no es participante NO puede iniciar (ni elegir participantes): 403', async () => {
      const repo = new InMemoryBattleRoomRepository()
      const publisher = recordingPublisher()

      await seed(repo)

      await expect(
        build(repo, { publisher }).useCase.execute(ROOM_ID, 'intruso'),
      ).rejects.toBeInstanceOf(RoomAccessForbiddenError)
      expect(publisher.published).toEqual([])
    })

    it('una sala WAITING_FOR_PLAYERS no inicia', async () => {
      const repo = new InMemoryBattleRoomRepository()

      await repo.save(preparingRoom().leave('b1'), 0)

      await expect(build(repo).useCase.execute(ROOM_ID, 'a1')).rejects.toBeInstanceOf(
        RoomNotStartableError,
      )
    })
  })

  describe('idempotencia y concurrencia: nunca dos colas ni dos battleStarted', () => {
    it('iniciar dos veces devuelve el estado vigente sin nuevo sorteo, sin nuevo evento y sin revalidar', async () => {
      const repo = new InMemoryBattleRoomRepository()
      const random = scriptedRandom([1])

      await seed(repo)
      const { useCase, publisher, heroes } = build(repo, { random })

      const first = await useCase.execute(ROOM_ID, 'a1')
      const callsAfterFirst = heroes.calls.length
      const second = await useCase.execute(ROOM_ID, 'b1')

      expect(second).toEqual(first)
      expect(random.bounds).toEqual([2])
      expect(heroes.calls).toHaveLength(callsAfterFirst)
      expect(publisher.published).toHaveLength(1)
    })

    it('una carrera perdida por el bloqueo optimista devuelve el estado ya iniciado por el ganador (sin segundo evento)', async () => {
      const inner = new InMemoryBattleRoomRepository()
      const publisher = recordingPublisher()

      await seed(inner)
      // El rival gana la carrera justo antes de nuestro `save`.
      const winner = build(inner, { random: scriptedRandom([0]) }).useCase
      let intercepted = false
      const racing: BattleRoomRepositoryPort = {
        findById: (id) => inner.findById(id),
        findWaitingForPlayers: () => inner.findWaitingForPlayers(),
        save: async (room, expectedVersion) => {
          if (!intercepted) {
            intercepted = true
            await winner.execute(ROOM_ID, 'b1')
          }

          return inner.save(room, expectedVersion)
        },
      }

      const dto = await build(racing, { random: scriptedRandom([1]), publisher }).useCase.execute(
        ROOM_ID,
        'a1',
      )

      expect(dto.status).toBe('IN_BATTLE')
      expect(dto.battle?.currentTurn.teamLabel).toBe('A') // la cola del ganador (sorteo 0)
      expect(publisher.published).toEqual([])
      expect((await inner.findById(ROOM_ID))?.events).toHaveLength(1)
    })

    it('un conflicto que NO es una batalla ya iniciada se propaga como RoomConflictError', async () => {
      const inner = new InMemoryBattleRoomRepository()

      await seed(inner)
      const conflicting: BattleRoomRepositoryPort = {
        findById: (id) => inner.findById(id),
        findWaitingForPlayers: () => inner.findWaitingForPlayers(),
        save: () => Promise.reject(new RoomConflictError(ROOM_ID)),
      }

      await expect(build(conflicting).useCase.execute(ROOM_ID, 'a1')).rejects.toBeInstanceOf(
        RoomConflictError,
      )
    })
  })

  describe('persistir ANTES de difundir (ADR-020)', () => {
    it('el orden observado es save y luego publish', async () => {
      const log: string[] = []
      const repo = loggingRepository(new InMemoryBattleRoomRepository(), log)
      const publisher = recordingPublisher(log)

      await repo.save(preparingRoom(), 0)
      log.length = 0
      await build(repo, { publisher }).useCase.execute(ROOM_ID, 'a1')

      expect(log).toEqual(['save:v2', 'publish:battleStarted#1'])
    })

    it('si la persistencia falla, NO se difunde nada y los clientes no creen que empezo', async () => {
      const inner = new InMemoryBattleRoomRepository()
      const publisher = recordingPublisher()

      await seed(inner)
      const failing: BattleRoomRepositoryPort = {
        findById: (id) => inner.findById(id),
        findWaitingForPlayers: () => inner.findWaitingForPlayers(),
        save: () => Promise.reject(new Error('mongo caido')),
      }

      await expect(build(failing, { publisher }).useCase.execute(ROOM_ID, 'a1')).rejects.toThrow(
        'mongo caido',
      )
      expect(publisher.published).toEqual([])
      expect((await inner.findById(ROOM_ID))?.status).toBe(BattleRoomStatus.Preparing)
    })

    it('un fallo al difundir NO revierte ni falla el inicio: el estado ya esta persistido', async () => {
      const repo = new InMemoryBattleRoomRepository()

      await seed(repo)
      const publisher = {
        published: [],
        publish: () => {
          throw new Error('gateway caido')
        },
      }

      const dto = await new StartBattle(
        repo,
        clock,
        heroesPort(),
        scriptedRandom([0]),
        publisher,
      ).execute(ROOM_ID, 'a1')

      expect(dto.status).toBe('IN_BATTLE')
      expect((await repo.findById(ROOM_ID))?.status).toBe(BattleRoomStatus.InBattle)
    })
  })

  it('usa la hora del reloj del servidor para startedAt (nunca del cliente)', async () => {
    const repo = new InMemoryBattleRoomRepository()

    await seed(repo)
    const dto = await build(repo).useCase.execute(ROOM_ID, 'a1')

    expect(dto.battle?.startedAt).toBe(NOW.toISOString())
  })
})
