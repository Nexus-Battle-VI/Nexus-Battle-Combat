import type { BattleDeadlineBookPort } from '../../../application/ports/BattleDeadlineBookPort'

/**
 * Libro de vencimientos en memoria (HU-21, contrato §3). Un instante por sala:
 * el proximo momento en que hay algo que liquidar.
 *
 *  - `ensureDueBy` conserva el MAS TEMPRANO (abrir una gracia no puede
 *    posponer un vencimiento global ni de turno anterior);
 *  - `setDue` reemplaza (tras liquidar, la sala fija su proximo vencimiento
 *    real: una sala que no esta en curso no promete nada).
 *
 * El barrido lo consulta cada segundo (`dueRooms`), asi que un vencimiento
 * pasado se procesa en el primer `tick` tras el arranque. La presencia se
 * limpia con `clear` al finalizar (via `BattleFinalizer`).
 */
export class InMemoryBattleDeadlineBook implements BattleDeadlineBookPort {
  private readonly byRoom = new Map<string, Date>()

  ensureDueBy(roomId: string, dueAt: Date): void {
    const current = this.byRoom.get(roomId)

    if (current === undefined || dueAt.getTime() < current.getTime()) {
      this.byRoom.set(roomId, dueAt)
    }
  }

  setDue(roomId: string, dueAt: Date): void {
    this.byRoom.set(roomId, dueAt)
  }

  cancel(roomId: string): void {
    this.byRoom.delete(roomId)
  }

  dueRooms(now: Date): readonly string[] {
    return [...this.byRoom.entries()]
      .filter(([, dueAt]) => dueAt.getTime() <= now.getTime())
      .map(([roomId]) => roomId)
  }
}
