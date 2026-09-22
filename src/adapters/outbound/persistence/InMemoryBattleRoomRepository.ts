import { BattleRoom, type BattleRoomSnapshot } from '../../../domain/entities/BattleRoom'
import { RoomConflictError } from '../../../application/errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../../../application/ports/BattleRoomRepositoryPort'

/**
 * Repositorio en memoria de salas de batalla (HU-14).
 *
 * Almacena instantaneas, no el agregado vivo, y reproduce el bloqueo
 * optimista de MongoDB comparando la version esperada con la almacenada:
 * las pruebas de los casos de uso ejercitan el conflicto sin contenedor.
 * Tambien respalda `PERSISTENCE_DRIVER=memory` en desarrollo, igual que el
 * resto de los repositorios del proyecto.
 */
export class InMemoryBattleRoomRepository implements BattleRoomRepositoryPort {
  private readonly byId = new Map<string, BattleRoomSnapshot>()

  findById(id: string): Promise<BattleRoom | null> {
    const snapshot = this.byId.get(id)

    return Promise.resolve(snapshot === undefined ? null : BattleRoom.restore(snapshot))
  }

  findWaitingForPlayers(): Promise<readonly BattleRoom[]> {
    const rooms = [...this.byId.values()]
      .filter((snapshot) => snapshot.status === 'WAITING_FOR_PLAYERS')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((snapshot) => BattleRoom.restore(snapshot))

    return Promise.resolve(rooms)
  }

  findInBattle(): Promise<readonly BattleRoom[]> {
    const rooms = [...this.byId.values()]
      .filter((snapshot) => snapshot.status === 'IN_BATTLE')
      .map((snapshot) => BattleRoom.restore(snapshot))

    return Promise.resolve(rooms)
  }

  findFinishedSince(since: Date): Promise<readonly BattleRoom[]> {
    const sinceIso = since.toISOString()
    const rooms = [...this.byId.values()]
      .filter(
        (snapshot) =>
          snapshot.status === 'FINISHED' &&
          snapshot.result !== null &&
          snapshot.result.finishedAt >= sinceIso,
      )
      .map((snapshot) => BattleRoom.restore(snapshot))

    return Promise.resolve(rooms)
  }

  save(room: BattleRoom, expectedVersion: number): Promise<BattleRoom> {
    const stored = this.byId.get(room.id)
    const storedVersion = stored?.version ?? 0

    if (storedVersion !== expectedVersion) {
      return Promise.reject(new RoomConflictError(room.id))
    }

    const persisted: BattleRoomSnapshot = {
      ...room.toSnapshot(),
      version: expectedVersion + 1,
    }

    this.byId.set(room.id, persisted)

    return Promise.resolve(BattleRoom.restore(persisted))
  }
}
