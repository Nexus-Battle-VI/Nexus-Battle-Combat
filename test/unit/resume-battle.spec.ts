import { ResumeBattle } from '../../src/application/use-cases/ResumeBattle'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { RoomAccessForbiddenError } from '../../src/application/errors/ApplicationError'
import { NOW, ROOM_ID } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'

/**
 * Recuperacion (HU-21, contrato §6.3): el `snapshot` gana `result` (el unico
 * resultado si la sala esta FINISHED, `null` si no) y la recuperacion informa
 * del estado, que es lo que el gateway usa para no suscribir una sala
 * terminada. Un `replay` no inventa nada: reenvia la bitacora persistida.
 */
describe('ResumeBattle — snapshot y replay con el resultado (HU-21)', () => {
  const repoWith = async (room = battleWithCombat()): Promise<InMemoryBattleRoomRepository> => {
    const repo = new InMemoryBattleRoomRepository()

    await repo.save(room, 0)

    return repo
  }

  it('una sala en curso devuelve `result: null` y su estado IN_BATTLE', async () => {
    const repo = await repoWith()
    const resume = new ResumeBattle(repo)

    const result = await resume.execute(ROOM_ID, 'a1', undefined)

    expect(result.kind).toBe('snapshot')
    expect(result.status).toBe('IN_BATTLE')

    if (result.kind === 'snapshot') {
      expect(result.snapshot.result).toBeNull()
      expect(result.snapshot.battle?.battleId).toBe(ROOM_ID)
    }
  })

  it('una sala FINISHED entrega el resultado completo en el snapshot', async () => {
    const repo = await repoWith()
    const room = await repo.findById(ROOM_ID)

    if (room === null) {
      throw new Error('la sala debia existir')
    }

    const finished = room.finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, NOW)

    await repo.save(finished, room.version)

    const resume = new ResumeBattle(repo)
    const result = await resume.execute(ROOM_ID, 'a1', undefined)

    expect(result.kind).toBe('snapshot')
    expect(result.status).toBe('FINISHED')

    if (result.kind === 'snapshot') {
      expect(result.snapshot.result).toEqual(finished.result)
      expect(result.snapshot.result?.reason).toBe('ELIMINATION')
      expect(result.snapshot.battle).not.toHaveProperty('deadlines')
    }
  })

  it('un `replay` reenvia la bitacora posterior e informa del estado', async () => {
    const repo = await repoWith()
    const room = await repo.findById(ROOM_ID)

    if (room === null) {
      throw new Error('la sala debia existir')
    }

    const finished = room.finish({ reason: 'TIME_LIMIT' }, NOW)

    await repo.save(finished, room.version)

    const resume = new ResumeBattle(repo)
    const result = await resume.execute(ROOM_ID, 'a1', 1)

    expect(result.kind).toBe('replay')
    expect(result.status).toBe('FINISHED')

    if (result.kind === 'replay') {
      expect(result.events.map((event) => event.type)).toEqual(['battleFinished'])
    }
  })

  it('un tercero no recupera nada (403)', async () => {
    const repo = await repoWith()
    const resume = new ResumeBattle(repo)

    await expect(resume.execute(ROOM_ID, 'intruso', undefined)).rejects.toBeInstanceOf(
      RoomAccessForbiddenError,
    )
  })
})
