import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import type { BattleRoom } from '../../domain/entities/BattleRoom'
import { RoomConflictError } from '../errors/ApplicationError'
import type { BattleDeadlineBookPort } from '../ports/BattleDeadlineBookPort'
import type { BattleEventPublisherPort } from '../ports/BattleEventPublisherPort'
import type { BattlePresencePort } from '../ports/BattlePresencePort'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { BattleFinalizer } from './BattleFinalizer'

/**
 * Liquida los vencimientos de UNA sala (HU-21, contrato §3, §4.5 y §7). Es el
 * UNICO lugar, junto a las acciones y `StartBattle`, donde se llama
 * `rooms.save`: las acciones y el barrido DELEGAN aqui, para que la regla de
 * una sola escritura por transicion no se pueda olvidar en un camino nuevo.
 *
 * El llamador YA tiene el cerrojo de la sala (`RoomCommandLockPort`): este
 * servicio no lo pide, igual que `ExecuteBasicAttack.executeExclusively`.
 *
 * Pasos:
 *  1. `now = clock.now()`; `next = room.settleDeadlines(now, presencia)`.
 *  2. Sin transicion (`next === room`) no escribe nada.
 *  3. UNA escritura. Ante `RoomConflictError` NO reintenta ni re-sortea: relee
 *     la sala vigente y la devuelve (el estado es determinista; quien llamo
 *     reevalua).
 *  4. Publica SOLO los eventos nuevos, DESPUES de persistir.
 *  5. Si quedo `FINISHED`, los efectos posteriores los hace el `BattleFinalizer`
 *     (planificador, presencia, lobby, liberacion, notificacion).
 *     Si sigue `IN_BATTLE`, reprograma el proximo vencimiento.
 */
export class BattleDeadlineSettler {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly presence: BattlePresencePort,
    private readonly book: BattleDeadlineBookPort,
    private readonly clock: ClockPort,
    private readonly events: BattleEventPublisherPort,
    private readonly finalizer: BattleFinalizer,
  ) {}

  async settle(room: BattleRoom): Promise<BattleRoom> {
    const now = this.clock.now()
    const next = room.settleDeadlines(now, this.presence.absences(room.id))

    if (next === room) {
      return room
    }

    let saved: BattleRoom

    try {
      saved = await this.rooms.save(next, room.version)
    } catch (error: unknown) {
      if (error instanceof RoomConflictError) {
        // Otra escritura gano la carrera: se devuelve lo vigente, sin repetir.
        // El estado es determinista, asi que quien llamo puede reevaluar.
        const current = await this.rooms.findById(room.id)

        return current ?? room
      }

      throw error
    }

    this.publishNewEvents(room, saved)

    if (saved.status === BattleRoomStatus.Finished) {
      this.finalizer.afterFinished(saved)
    } else {
      const due = saved.nextDueAt(this.presence.absences(room.id))

      if (due !== null) {
        this.book.setDue(room.id, due)
      }
    }

    return saved
  }

  /** Los eventos de ESTA escritura (`seq` mayor que el ultimo conocido), ya persistidos. */
  private publishNewEvents(before: BattleRoom, saved: BattleRoom): void {
    const fresh = saved.eventsAfter(before.lastSeq)

    if (fresh.length === 0) {
      return
    }

    try {
      this.events.publish(saved.id, fresh)
    } catch {
      // El estado ya esta persistido; un cliente que se pierda el evento usa `resume`.
    }
  }
}
