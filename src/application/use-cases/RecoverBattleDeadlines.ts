import { ParticipantKind } from '../../domain/entities/Participant'
import type { BattleDeadlineBookPort } from '../ports/BattleDeadlineBookPort'
import type { BattlePresencePort } from '../ports/BattlePresencePort'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'

/**
 * Recupera los vencimientos al ARRANCAR el servicio (HU-21, contrato §3 y §4.2):
 *
 *  - los vencimientos GLOBALES y de TURNO son derivables del estado persistido,
 *    asi que sobreviven a un reinicio;
 *  - la presencia no se persiste (es de la conexion): tras un arranque no hay
 *    ninguna conexion de batalla, asi que TODO participante HUMANO de una
 *    batalla `IN_BATTLE` queda ausente desde AHORA y tiene 30 s para reconectar.
 *
 * Registra el primer vencimiento de cada sala en el libro. Devuelve cuantas
 * salas quedo vigilando (util para el registro del arranque).
 */
export class RecoverBattleDeadlines {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly presence: BattlePresencePort,
    private readonly book: BattleDeadlineBookPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(): Promise<number> {
    const rooms = await this.rooms.findInBattle()
    const now = this.clock.now()

    for (const room of rooms) {
      const battle = room.battle

      if (battle === null) {
        continue
      }

      for (const entry of battle.turnOrder) {
        if (entry.kind === ParticipantKind.Human && entry.playerId !== null) {
          this.presence.markAbsent(room.id, entry.playerId, now)
        }
      }

      const due = room.nextDueAt(this.presence.absences(room.id))

      if (due !== null) {
        this.book.ensureDueBy(room.id, due)
      }
    }

    return rooms.length
  }
}
