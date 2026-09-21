import type { BattleEvent } from '../../domain/entities/BattleEvent'
import type { BattleSnapshotWire } from '../dto/BattleEventDto'
import { RoomAccessForbiddenError, RoomNotFoundError } from '../errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'

export type ResumeResult =
  | { readonly kind: 'replay'; readonly seq: number; readonly events: readonly BattleEvent[] }
  | { readonly kind: 'snapshot'; readonly seq: number; readonly snapshot: BattleSnapshotWire }

/**
 * Recuperacion tras una reconexion (ADR-020, HU-17): `{"type":"resume",
 * "roomId","lastSeq"}`.
 *
 *  - `lastSeq` entre 1 y el ultimo `seq`: los eventos posteriores siguen en la
 *    bitacora persistida, se reenvian EN ORDEN (`replay`; puede ser vacio).
 *  - `lastSeq` ausente, invalido o mayor que el ultimo `seq`: instantanea
 *    completa del estado visible (`snapshot`). No se inventan mensajes.
 *
 * SOLO para participantes HUMAN de la sala (`RoomAccessForbiddenError`): un
 * tercero no puede leer ni el estado ni los eventos de una batalla ajena.
 */
export class ResumeBattle {
  constructor(private readonly rooms: BattleRoomRepositoryPort) {}

  async execute(roomId: string, requesterId: string, lastSeq: unknown): Promise<ResumeResult> {
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      throw new RoomNotFoundError(roomId)
    }

    if (!room.isParticipant(requesterId)) {
      throw new RoomAccessForbiddenError(roomId)
    }

    const seq = room.lastSeq

    if (
      typeof lastSeq === 'number' &&
      Number.isInteger(lastSeq) &&
      lastSeq >= 1 &&
      lastSeq <= seq
    ) {
      return { kind: 'replay', seq, events: room.eventsAfter(lastSeq) }
    }

    return {
      kind: 'snapshot',
      seq,
      snapshot: {
        type: 'snapshot',
        roomId: room.id,
        seq,
        status: room.status,
        battle: room.battleView(),
      },
    }
  }
}
