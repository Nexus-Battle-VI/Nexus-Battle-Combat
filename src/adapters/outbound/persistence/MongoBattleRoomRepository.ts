import { Int32, MongoServerError, type Collection, type Db } from 'mongodb'

import { BattleRoom } from '../../../domain/entities/BattleRoom'
import { RoomConflictError } from '../../../application/errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../../../application/ports/BattleRoomRepositoryPort'
import { toDocument, toSnapshot, type BattleRoomDocument } from './battle-room-mapping'

/**
 * Repositorio de salas de batalla sobre MongoDB (HU-14).
 *
 * La condicion de version viaja DENTRO del `replaceOne`, igual que
 * `MongoHeroSelectionRepository.ts`/`MongoHeroLoadoutRepository.ts`: dos
 * escrituras simultaneas sobre la misma sala no pueden progresar ambas,
 * porque la segunda no encuentra documento con la version esperada y se
 * traduce a 409. No hace falta transaccion: la sala, con sus equipos
 * embebidos, es un solo documento y su escritura ya es atomica en el motor.
 */
export class MongoBattleRoomRepository implements BattleRoomRepositoryPort {
  private readonly rooms: Collection<BattleRoomDocument>

  constructor(db: Db) {
    this.rooms = db.collection<BattleRoomDocument>('battle-rooms')
  }

  async findById(id: string): Promise<BattleRoom | null> {
    const document = await this.rooms.findOne({ _id: id })

    return document === null ? null : BattleRoom.restore(toSnapshot(document))
  }

  async findWaitingForPlayers(): Promise<readonly BattleRoom[]> {
    const documents = await this.rooms
      .find({ status: 'WAITING_FOR_PLAYERS' })
      .sort({ status: 1, createdAt: -1 })
      .toArray()

    return documents.map((document) => BattleRoom.restore(toSnapshot(document)))
  }

  async findInBattle(): Promise<readonly BattleRoom[]> {
    const documents = await this.rooms.find({ status: 'IN_BATTLE' }).toArray()

    return documents.map((document) => BattleRoom.restore(toSnapshot(document)))
  }

  async findFinishedSince(since: Date): Promise<readonly BattleRoom[]> {
    const documents = await this.rooms
      .find({ status: 'FINISHED', 'result.finishedAt': { $gte: since.toISOString() } })
      .toArray()

    return documents.map((document) => BattleRoom.restore(toSnapshot(document)))
  }

  async save(room: BattleRoom, expectedVersion: number): Promise<BattleRoom> {
    const next: BattleRoomDocument = {
      ...toDocument(room.toSnapshot()),
      version: new Int32(expectedVersion + 1),
    }

    if (expectedVersion === 0) {
      try {
        await this.rooms.insertOne(next)
      } catch (error: unknown) {
        // Otra peticion creo la sala con el mismo id primero: conflicto de
        // version, no un fallo del servicio. Con un UUID v4 generado por el
        // servidor esto practicamente no ocurre, pero el patron se mantiene
        // identico al del resto del proyecto.
        if (error instanceof MongoServerError && error.code === 11000) {
          throw new RoomConflictError(room.id)
        }
        throw error
      }
    } else {
      const result = await this.rooms.replaceOne(
        { _id: next._id, version: new Int32(expectedVersion) },
        next,
      )

      if (result.matchedCount === 0) {
        throw new RoomConflictError(room.id)
      }
    }

    return BattleRoom.restore(toSnapshot(next))
  }
}
