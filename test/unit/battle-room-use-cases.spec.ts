import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { RoomConflictError, RoomNotFoundError } from '../../src/application/errors/ApplicationError'
import {
  RoomCancellationForbiddenError,
  RoomNotCancellableError,
} from '../../src/domain/errors/BattleRoomErrors'
import type { CreateBattleRoomInput } from '../../src/domain/entities/BattleRoom'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import { CancelBattleRoom } from '../../src/application/use-cases/CancelBattleRoom'
import { CreateBattleRoom } from '../../src/application/use-cases/CreateBattleRoom'
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
