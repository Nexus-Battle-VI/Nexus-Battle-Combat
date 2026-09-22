import type { BattleRoom } from '../../domain/entities/BattleRoom'
import { creditEntitlements } from '../../domain/policies/BattleCreditsPolicy'
import type { BattleDeadlineBookPort } from '../ports/BattleDeadlineBookPort'
import type { BattlePresencePort } from '../ports/BattlePresencePort'
import type {
  BattleFinishedNotification,
  BattleResultPublisherPort,
} from '../ports/BattleResultPublisherPort'
import type { BattleRoomReleasePort } from '../ports/BattleRoomReleasePort'
import type { RealtimeNotifierPort } from '../ports/RealtimeNotifierPort'

/** Lo unico que el finalizador necesita de un registro estructurado. */
export interface BattleFinalizerLogger {
  error(message: string, context?: Readonly<Record<string, string>>): void
}

/**
 * Efectos posteriores a persistir una sala `FINISHED` (HU-21, contrato §8 y §9),
 * en ORDEN FIJO:
 *
 *  1. cancelar los vencimientos de la sala (planificador),
 *  2. olvidar su presencia (ya no hay gracia que contar),
 *  3. avisar al lobby (`battle-room.updated` con `status: FINISHED`; el chat
 *     revalida el acceso),
 *  4. liberar las conexiones de batalla (sin cerrar sockets),
 *  5. publicar la notificacion a consumidores con los creditos como derecho.
 *
 * NUNCA LANZA: cada paso va en su propio `try/catch` y un fallo se registra sin
 * impedir los siguientes. La batalla ya esta persistida; una señal que no salga
 * no puede revertirla (contrato §9: semantica *al menos una vez*).
 *
 * NO lleva guarda interna de «ya finalizo»: la unicidad la da el bloqueo
 * optimista (una sola escritura llega a FINISHED y solo quien la logra llama
 * aqui). Un conjunto de salas finalizadas seria una fuga de memoria.
 */
export class BattleFinalizer {
  constructor(
    private readonly book: BattleDeadlineBookPort,
    private readonly presence: BattlePresencePort,
    private readonly notifier: RealtimeNotifierPort,
    private readonly release: BattleRoomReleasePort,
    private readonly results: BattleResultPublisherPort,
    private readonly logger: BattleFinalizerLogger,
  ) {}

  afterFinished(room: BattleRoom): void {
    this.step('book_cancel', () => {
      this.book.cancel(room.id)
    })
    this.step('presence_clear', () => {
      this.presence.clear(room.id)
    })
    this.step('room_updated', () => {
      this.notifier.notifyRoomUpdated({
        roomId: room.id,
        status: room.status,
        version: room.version,
      })
    })
    this.step('room_release', () => {
      this.release.release(room.id)
    })
    this.step('result_publish', () => {
      const notification = buildBattleFinishedNotification(room)

      if (notification !== null) {
        this.results.publish(notification)
      }
    })
  }

  private step(name: string, action: () => void): void {
    try {
      action()
    } catch (error: unknown) {
      this.logger.error('battle_finalizacion_paso_fallo', {
        step: name,
        reason: error instanceof Error ? error.name : 'desconocido',
      })
    }
  }
}

/**
 * La notificacion de consumidores (contrato §9). `credits` es un DERECHO segun
 * §7.6: Combat no acredita nada y ningun transporte entre servicios existe
 * todavia (el adaptador solo registra).
 *
 * Exportada (no privada del modulo): `ReconcileRewardWorkflows` (HU-22)
 * reconstruye la MISMA notificacion a partir de una sala `FINISHED` ya
 * persistida, para recrear un `RewardWorkflow` que el `publish()`
 * fire-and-forget de `afterFinished` no llego a crear antes de un reinicio.
 * Una sola fuente de la traduccion `BattleRoom -> BattleFinishedNotification`.
 */
export const buildBattleFinishedNotification = (
  room: BattleRoom,
): BattleFinishedNotification | null => {
  const result = room.result

  if (result === null) {
    return null
  }

  const credits = creditEntitlements(result)

  return {
    roomId: room.id,
    mode: room.mode,
    finishedAt: result.finishedAt,
    reason: result.reason,
    outcome: result.outcome,
    winnerTeamLabel: result.winnerTeamLabel,
    participants: result.participants.map((participant) => {
      const entitlement = credits.find(
        (candidate) =>
          candidate.teamLabel === participant.teamLabel && candidate.seat === participant.seat,
      )

      return {
        kind: participant.kind,
        playerId: participant.playerId,
        heroId: participant.heroId,
        teamLabel: participant.teamLabel,
        seat: participant.seat,
        result: participant.result,
        credits: entitlement?.credits ?? null,
      }
    }),
    configuredReward: room.reward.toSnapshot(),
  }
}
