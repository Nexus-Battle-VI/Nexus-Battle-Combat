import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { RoomConflictError, RoomNotFoundError } from '../../src/application/errors/ApplicationError'
import {
  PlayerAlreadyJoinedError,
  RoomCancellationForbiddenError,
  RoomFullError,
  RoomNotCancellableError,
  RoomNotJoinableError,
} from '../../src/domain/errors/BattleRoomErrors'
import { BattleRoom, type CreateBattleRoomInput } from '../../src/domain/entities/BattleRoom'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import { CancelBattleRoom } from '../../src/application/use-cases/CancelBattleRoom'
import { CreateBattleRoom } from '../../src/application/use-cases/CreateBattleRoom'
import { JoinBattleRoom } from '../../src/application/use-cases/JoinBattleRoom'
import { ListAvailableBattleRooms } from '../../src/application/use-cases/ListAvailableBattleRooms'

const AT = new Date('2026-09-17T12:00:00.000Z')
const CREATOR = 'jugador-creador'

const fixedClock = (): ClockPort => ({ now: () => AT })

const sequentialIds = (): IdGeneratorPort => {
  let counter = 0

  return {
    generate: () => {
      counter += 1
      return `00000000-0000-4000-8000-00000000000${String(counter)}`
    },
  }
}

const basicInput = (overrides: Partial<CreateBattleRoomInput> = {}): CreateBattleRoomInput => ({
  mode: 'PVP',
  teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
  reward: { amount: 0 },
  ...overrides,
})

describe('CreateBattleRoom', () => {
  it('crea la sala, resuelve createdBy del identificador verificado y no del cuerpo', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const useCase = new CreateBattleRoom(repo, sequentialIds(), fixedClock())

    const dto = await useCase.execute(CREATOR, basicInput())

    expect(dto.createdBy).toBe(CREATOR)
    expect(dto.status).toBe('WAITING_FOR_PLAYERS')
    expect(dto.version).toBe(1)
    expect(dto.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('resuelve el playerId de un HUMAN inicial al creador, aunque el cliente no lo declare', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const useCase = new CreateBattleRoom(repo, sequentialIds(), fixedClock())

    const dto = await useCase.execute(
      CREATOR,
      basicInput({
        teamConfigs: [{ capacity: 3, initialParticipants: [{ kind: 'HUMAN' }] }, { capacity: 3 }],
      }),
    )

    expect(dto.teams[0].participants[0]).toMatchObject({ kind: 'HUMAN', playerId: CREATOR })
  })
})

describe('ListAvailableBattleRooms', () => {
  it('solo devuelve salas WAITING_FOR_PLAYERS con cupo', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const list = new ListAvailableBattleRooms(repo)

    const available = await create.execute(CREATOR, basicInput())
    // Llena la sala con un HUMAN (el creador) y un AI en el otro equipo: dos
    // HUMAN declarados resolverian ambos al mismo `createdBy` y violarian la
    // invariante de unicidad de jugador (ver BattleRoom.validateUniqueHumanPlayers).
    const full = await create.execute(
      CREATOR,
      basicInput({
        mode: 'PVE',
        teamConfigs: [
          { capacity: 1, initialParticipants: [{ kind: 'HUMAN' }] },
          { capacity: 1, initialParticipants: [{ kind: 'AI' }] },
        ],
      }),
    )
    const cancel = new CancelBattleRoom(repo)
    const cancelled = await create.execute(CREATOR, basicInput())
    await cancel.execute(cancelled.id, CREATOR)

    const result = await list.execute()

    expect(result.map((room) => room.id)).toEqual([available.id])
    expect(result.map((room) => room.id)).not.toContain(full.id)
  })
})

describe('CancelBattleRoom', () => {
  it('el creador cancela una sala valida', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const cancel = new CancelBattleRoom(repo)

    const created = await create.execute(CREATOR, basicInput())
    const cancelled = await cancel.execute(created.id, CREATOR)

    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.version).toBe(2)
  })

  it('sala inexistente -> RoomNotFoundError', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const cancel = new CancelBattleRoom(repo)

    await expect(cancel.execute('sala-que-no-existe', CREATOR)).rejects.toBeInstanceOf(
      RoomNotFoundError,
    )
  })

  it('quien no es el creador no puede cancelar', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const cancel = new CancelBattleRoom(repo)

    const created = await create.execute(CREATOR, basicInput())

    await expect(cancel.execute(created.id, 'otro-jugador')).rejects.toBeInstanceOf(
      RoomCancellationForbiddenError,
    )
  })

  it('sala ya no cancelable -> RoomNotCancellableError', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const cancel = new CancelBattleRoom(repo)

    const created = await create.execute(CREATOR, basicInput())
    await cancel.execute(created.id, CREATOR)

    await expect(cancel.execute(created.id, CREATOR)).rejects.toBeInstanceOf(
      RoomNotCancellableError,
    )
  })

  it('conflicto de bloqueo optimista -> RoomConflictError', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const created = await create.execute(CREATOR, basicInput())

    const room = await repo.findById(created.id)
    if (room === null) throw new Error('la sala debia existir')

    const cancelled = room.cancel(CREATOR)

    // Primer guardado con la version leida: prospera y la adelanta.
    await repo.save(cancelled, room.version)
    // Segundo guardado con la MISMA version esperada, ya desactualizada:
    // otra escritura (la anterior) ya avanzo la version real.
    await expect(repo.save(cancelled, room.version)).rejects.toBeInstanceOf(RoomConflictError)
  })
})

describe('JoinBattleRoom', () => {
  const JOINER = 'jugador-que-se-une'

  it('sala inexistente -> RoomNotFoundError', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const join = new JoinBattleRoom(repo, fixedClock())

    await expect(join.execute('sala-que-no-existe', JOINER, null)).rejects.toBeInstanceOf(
      RoomNotFoundError,
    )
  })

  it('camino feliz: orquesta findById -> room.join() -> save(room, expectedVersion) y devuelve el DTO', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const join = new JoinBattleRoom(repo, fixedClock())

    const created = await create.execute(
      CREATOR,
      basicInput({ teamConfigs: [{ capacity: 2 }, { capacity: 2 }] }),
    )
    const dto = await join.execute(created.id, JOINER, null)

    expect(dto.status).toBe('WAITING_FOR_PLAYERS')
    expect(dto.version).toBe(2)
    const allParticipants = [...dto.teams[0].participants, ...dto.teams[1].participants]
    expect(allParticipants).toContainEqual(expect.objectContaining({ playerId: JOINER }))
  })

  it('el join que ocupa el ultimo cupo persiste PREPARING', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const join = new JoinBattleRoom(repo, fixedClock())

    const created = await create.execute(
      CREATOR,
      basicInput({
        teamConfigs: [{ capacity: 1, initialParticipants: [{ kind: 'HUMAN' }] }, { capacity: 1 }],
      }),
    )

    const dto = await join.execute(created.id, JOINER, null)

    expect(dto.status).toBe('PREPARING')
  })

  it('propaga RoomConflictError cuando el repositorio detecta que otra escritura adelanto la version entre la lectura y el guardado', async () => {
    // El caso de uso no puede FORZAR una carrera real con un repositorio en
    // memoria de un solo hilo (JoinBattleRoom.execute siempre relee antes de
    // escribir, asi que una segunda escritura externa ya no chocaria con la
    // suya: releeria la version fresca). Lo que SI se puede probar desde
    // aqui, sin tocar el dominio, es el contrato exacto que
    // `HU-15.2-Plan-Implementacion.md` (seccion 2.2, escenario 13) exige:
    // "si repository.save() rechaza con RoomConflictError, el caso de uso lo
    // propaga tal cual, sin ocultarlo ni reintentar en un bucle oculto".
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const created = await create.execute(
      CREATOR,
      basicInput({ teamConfigs: [{ capacity: 2 }, { capacity: 2 }] }),
    )

    const conflictingRepo: BattleRoomRepositoryPort = {
      findById: (id) => repo.findById(id),
      findWaitingForPlayers: () => repo.findWaitingForPlayers(),
      save: () => Promise.reject(new RoomConflictError(created.id)),
    }
    const join = new JoinBattleRoom(conflictingRepo, fixedClock())

    await expect(join.execute(created.id, JOINER, null)).rejects.toBeInstanceOf(RoomConflictError)
  })

  it('ausencia de persistencia parcial: RoomNotJoinableError nunca invoca repository.save()', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const cancel = new CancelBattleRoom(repo)
    const join = new JoinBattleRoom(repo, fixedClock())

    const created = await create.execute(CREATOR, basicInput())
    await cancel.execute(created.id, CREATOR)

    const saveSpy = jest.spyOn(repo, 'save')

    await expect(join.execute(created.id, JOINER, null)).rejects.toBeInstanceOf(
      RoomNotJoinableError,
    )
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('ausencia de persistencia parcial: RoomFullError nunca invoca repository.save()', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const join = new JoinBattleRoom(repo, fixedClock())

    const created = await create.execute(
      CREATOR,
      basicInput({
        teamConfigs: [{ capacity: 1, initialParticipants: [{ kind: 'HUMAN' }] }, { capacity: 1 }],
      }),
    )

    const saveSpy = jest.spyOn(repo, 'save')

    await expect(join.execute(created.id, JOINER, 'A')).rejects.toBeInstanceOf(RoomFullError)
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('ausencia de persistencia parcial: PlayerAlreadyJoinedError nunca invoca repository.save()', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())
    const join = new JoinBattleRoom(repo, fixedClock())

    const created = await create.execute(
      CREATOR,
      basicInput({ teamConfigs: [{ capacity: 2 }, { capacity: 2 }] }),
    )
    await join.execute(created.id, JOINER, null)

    const saveSpy = jest.spyOn(repo, 'save')

    await expect(join.execute(created.id, JOINER, null)).rejects.toBeInstanceOf(
      PlayerAlreadyJoinedError,
    )
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('llama a save() con expectedVersion igual a la version leida de la sala', async () => {
    const repo: BattleRoomRepositoryPort = new InMemoryBattleRoomRepository()
    const create = new CreateBattleRoom(repo, sequentialIds(), fixedClock())

    const created = await create.execute(
      CREATOR,
      basicInput({ teamConfigs: [{ capacity: 2 }, { capacity: 2 }] }),
    )

    const saveSpy = jest.spyOn(repo, 'save')
    const join = new JoinBattleRoom(repo, fixedClock())

    await join.execute(created.id, JOINER, null)

    expect(saveSpy).toHaveBeenCalledWith(expect.any(BattleRoom), 1)
  })
})
