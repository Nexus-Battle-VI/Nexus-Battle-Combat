import type { BattlePresencePort } from '../../../application/ports/BattlePresencePort'

/**
 * Presencia de los participantes en memoria (HU-21, contrato §4.2).
 *
 * ADR-020: la presencia es de la CONEXION y vive en el proceso (una sola
 * replica); no se persiste y no consulta a nadie. Los sockets los conoce el
 * gateway; este registro solo guarda, por sala y jugador, desde cuando esta
 * ausente.
 *
 * `markAbsent` CONSERVA el `since` mas ANTIGUO: la gracia corre desde la
 * primera vez que se perdio la ultima conexion. Una sala sin ausencias no
 * ocupa estructura (se elimina la clave) y `clear` la libera al terminar.
 */
export class InMemoryBattlePresenceRegistry implements BattlePresencePort {
  private readonly byRoom = new Map<string, Map<string, Date>>()

  markAbsent(roomId: string, playerId: string, since: Date): void {
    const room = this.roomOf(roomId)
    const current = room.get(playerId)

    if (current === undefined || since.getTime() < current.getTime()) {
      room.set(playerId, since)
    }
  }

  markPresent(roomId: string, playerId: string): void {
    const room = this.byRoom.get(roomId)

    if (room === undefined) {
      return
    }

    room.delete(playerId)

    if (room.size === 0) {
      this.byRoom.delete(roomId)
    }
  }

  absences(roomId: string): ReadonlyMap<string, Date> {
    const room = this.byRoom.get(roomId)

    return room === undefined ? new Map<string, Date>() : new Map(room)
  }

  clear(roomId: string): void {
    this.byRoom.delete(roomId)
  }

  private roomOf(roomId: string): Map<string, Date> {
    const existing = this.byRoom.get(roomId)

    if (existing !== undefined) {
      return existing
    }

    const created = new Map<string, Date>()
    this.byRoom.set(roomId, created)

    return created
  }
}
