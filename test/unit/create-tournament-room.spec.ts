import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { RoomConflictError } from '../../src/application/errors/ApplicationError'
import { InvalidTournamentRosterError } from '../../src/domain/errors/BattleRoomErrors'
import { TournamentRoomOperationReusedError } from '../../src/application/errors/TournamentRoomErrors'
import {
  AccountProfileMissingError,
  PlayerWithoutEquippedHeroError,
} from '../../src/application/errors/UpstreamErrors'
import type { AccountBattleProfilePort } from '../../src/application/ports/AccountBattleProfilePort'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import type { PlayerInventoryEquippedHeroPort } from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import {
  CreateTournamentRoom,
  type CreateTournamentRoomRequest,
} from '../../src/application/use-cases/CreateTournamentRoom'
import { equippedHeroFixture } from '../fixtures/equipped-hero'

const AT = new Date('2026-10-01T12:00:00.000Z')
const fixedClock = (): ClockPort => ({ now: () => AT })

const fakeAccountProfiles = (): AccountBattleProfilePort => ({
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `nombre-de-${subject}`, avatarUrl: null }),
})

const fakeEquippedHeroes = (): PlayerInventoryEquippedHeroPort => ({
  getEquippedHero: (playerId) =>
    Promise.resolve(equippedHeroFixture({ playerId, heroId: `heroe-de-${playerId}` })),
})

const sequentialIds = (): IdGeneratorPort => {
  let counter = 0

  return {
    generate: () => {
      counter += 1

      return `00000000-0000-4000-8000-00000000000${String(counter)}`
    },
  }
}

const REQUEST: CreateTournamentRoomRequest = {
  operationId: 'T1:E1',
  tournamentId: 'T1',
  encounterId: 'T1:E1',
  teams: [
    { teamId: 'equipo1', memberIds: ['p1', 'p2'] },
    { teamId: 'equipo2', memberIds: ['p3', 'p4'] },
  ],
}
const REQUEST_HASH = 'a'.repeat(64)

const build = (
  overrides: {
    rooms?: BattleRoomRepositoryPort
    accountProfiles?: AccountBattleProfilePort
    equippedHeroes?: PlayerInventoryEquippedHeroPort
  } = {},
): { useCase: CreateTournamentRoom; rooms: BattleRoomRepositoryPort } => {
  const rooms = overrides.rooms ?? new InMemoryBattleRoomRepository()

  return {
    rooms,
    useCase: new CreateTournamentRoom(
      rooms,
      sequentialIds(),
      fixedClock(),
      overrides.accountProfiles ?? fakeAccountProfiles(),
      overrides.equippedHeroes ?? fakeEquippedHeroes(),
    ),
  }
}

describe('CreateTournamentRoom (Management#517)', () => {
  it('crea una sala con los 4 jugadores resueltos, YA en PREPARING y fuera del listado publico', async () => {
    const { useCase, rooms } = build()

    const dto = await useCase.execute(REQUEST, REQUEST_HASH)

    expect(dto.status).toBe('PREPARING')
    expect(dto.mode).toBe('PVP')
    expect(dto.teams[0]).toMatchObject({
      label: 'equipo1',
      participants: [
        { playerId: 'p1', heroId: 'heroe-de-p1', displayName: 'nombre-de-p1' },
        { playerId: 'p2', heroId: 'heroe-de-p2', displayName: 'nombre-de-p2' },
      ],
    })
    expect(dto.teams[1].participants.map((p) => p.playerId)).toEqual(['p3', 'p4'])

    expect(await rooms.findWaitingForPlayers()).toHaveLength(0)
  })

  it('el creador es un identificador sintetico del servicio, nunca un playerId del roster', async () => {
    const { useCase } = build()

    const dto = await useCase.execute(REQUEST, REQUEST_HASH)

    expect(dto.createdBy).toBe('tournament:T1')
    expect(['p1', 'p2', 'p3', 'p4']).not.toContain(dto.createdBy)
  })

  it('es IDEMPOTENTE: el mismo operationId con el mismo cuerpo devuelve la MISMA sala', async () => {
    const { useCase, rooms } = build()

    const first = await useCase.execute(REQUEST, REQUEST_HASH)
    const second = await useCase.execute(REQUEST, REQUEST_HASH)

    expect(second).toEqual(first)
    expect(await rooms.findById(first.id)).not.toBeNull()
  })

  it('el mismo operationId con un cuerpo DISTINTO responde con un error de reutilizacion', async () => {
    const { useCase } = build()

    await useCase.execute(REQUEST, REQUEST_HASH)

    await expect(useCase.execute(REQUEST, 'b'.repeat(64))).rejects.toBeInstanceOf(
      TournamentRoomOperationReusedError,
    )
  })

  it('dos creaciones concurrentes con el mismo operationId no producen una segunda sala', async () => {
    const inner = new InMemoryBattleRoomRepository()
    let intercepted = false
    const racing: BattleRoomRepositoryPort = {
      findById: (id) => inner.findById(id),
      findWaitingForPlayers: () => inner.findWaitingForPlayers(),
      findInBattle: () => inner.findInBattle(),
      findFinishedSince: (since) => inner.findFinishedSince(since),
      findCancelledSince: (since) => inner.findCancelledSince(since),
      findActiveByParticipant: (playerId) => inner.findActiveByParticipant(playerId),
      findByTournamentOperationId: (operationId) => inner.findByTournamentOperationId(operationId),
      save: async (room, expectedVersion) => {
        if (!intercepted) {
          intercepted = true
          // La "otra peticion" gana la carrera e inserta primero.
          await new CreateTournamentRoom(
            inner,
            sequentialIds(),
            fixedClock(),
            fakeAccountProfiles(),
            fakeEquippedHeroes(),
          ).execute(REQUEST, REQUEST_HASH)
        }

        return inner.save(room, expectedVersion)
      },
    }

    const { useCase } = build({ rooms: racing })
    const dto = await useCase.execute(REQUEST, REQUEST_HASH)

    const winnerByOperation = await inner.findByTournamentOperationId(REQUEST.operationId)
    expect(winnerByOperation?.id).toBe(dto.id)
  })

  it('un jugador sin heroe equipado detiene la creacion con 422 (sin persistir nada)', async () => {
    const { useCase, rooms } = build({
      equippedHeroes: {
        getEquippedHero: (playerId) =>
          Promise.resolve(playerId === 'p3' ? null : equippedHeroFixture({ playerId })),
      },
    })

    await expect(useCase.execute(REQUEST, REQUEST_HASH)).rejects.toBeInstanceOf(
      PlayerWithoutEquippedHeroError,
    )
    expect(await rooms.findByTournamentOperationId(REQUEST.operationId)).toBeNull()
  })

  it('un jugador sin perfil en Account propaga el error de negocio (422), sin reinventar la resolucion', async () => {
    const { useCase } = build({
      accountProfiles: {
        getBattleProfile: (subject) => Promise.reject(new AccountProfileMissingError(subject)),
      },
    })

    await expect(useCase.execute(REQUEST, REQUEST_HASH)).rejects.toBeInstanceOf(
      AccountProfileMissingError,
    )
  })

  it('una escritura rechazada con un conflicto de verdad (no de operationId) se propaga tal cual', async () => {
    const unreachable = (): never => {
      throw new Error('no deberia llamarse en esta prueba')
    }
    const failing: BattleRoomRepositoryPort = {
      findById: unreachable,
      findWaitingForPlayers: unreachable,
      findInBattle: unreachable,
      findFinishedSince: unreachable,
      findCancelledSince: unreachable,
      findActiveByParticipant: unreachable,
      findByTournamentOperationId: () => Promise.resolve(null),
      save: () => Promise.reject(new RoomConflictError('otra-sala')),
    }

    const { useCase } = build({ rooms: failing })

    await expect(useCase.execute(REQUEST, REQUEST_HASH)).rejects.toBeInstanceOf(RoomConflictError)
  })

  it('rechaza un equipo con un numero de jugadores distinto de 2 ANTES de llamar a Account ni a Player/Inventory', async () => {
    const accountProfiles = fakeAccountProfiles()
    const equippedHeroes = fakeEquippedHeroes()
    const getBattleProfile = jest.spyOn(accountProfiles, 'getBattleProfile')
    const getEquippedHero = jest.spyOn(equippedHeroes, 'getEquippedHero')
    const { useCase, rooms } = build({ accountProfiles, equippedHeroes })
    const oversized: CreateTournamentRoomRequest = {
      ...REQUEST,
      teams: [
        { teamId: 'equipo1', memberIds: ['p1', 'p2', 'p3'] },
        { teamId: 'equipo2', memberIds: ['p4', 'p5'] },
      ],
    }

    await expect(useCase.execute(oversized, REQUEST_HASH)).rejects.toBeInstanceOf(
      InvalidTournamentRosterError,
    )
    expect(getBattleProfile).not.toHaveBeenCalled()
    expect(getEquippedHero).not.toHaveBeenCalled()
    await expect(rooms.findByTournamentOperationId(REQUEST.operationId)).resolves.toBeNull()
  })
})
