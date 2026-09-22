import type {
  BattleOutcome,
  BattleFinishReason,
  ParticipantResultKind,
} from '../../domain/entities/BattleResult'

/**
 * Notificacion a los consumidores de la finalizacion de una batalla (HU-21,
 * contrato §9). Es la señal que desbloquea HU-22 (cofre), HU-23 (apuesta),
 * HU-30 (caida de items), HU-29 (liberacion del bloqueo de equipamiento) y
 * HU-09 (experiencia): aqui NO se implementa ninguna de esas historias.
 *
 * `credits` es un DERECHO publicado, no una acreditacion: Combat no tiene API
 * de acreditacion y Web no los muestra como concedidos (decision de Dabji,
 * pendiente de ratificar por el PO). `null` para un participante `AI`.
 *
 * Semantica de entrega: AL MENOS UNA VEZ, con clave de idempotencia `roomId`.
 * Un fallo al publicar se registra y no revierte la batalla.
 */
export interface BattleFinishedParticipant {
  readonly kind: 'HUMAN' | 'AI'
  readonly playerId: string | null
  /** El heroe beneficiario del resultado (HU-09). */
  readonly heroId: string | null
  readonly teamLabel: string
  readonly seat: number
  readonly result: ParticipantResultKind
  /** Derecho segun §7.6; `null` para `AI`; NO acreditado. */
  readonly credits: number | null
}

export interface BattleFinishedNotification {
  readonly roomId: string
  readonly mode: string
  readonly finishedAt: string
  readonly reason: BattleFinishReason
  readonly outcome: BattleOutcome
  readonly winnerTeamLabel: string | null
  readonly participants: readonly BattleFinishedParticipant[]
  /** La recompensa configurada de la sala, tal cual (HU-23 la interpreta). */
  readonly configuredReward: { readonly amount: number }
}

export interface BattleResultPublisherPort {
  publish(notification: BattleFinishedNotification): void
}

export const BATTLE_RESULT_PUBLISHER = Symbol('BattleResultPublisherPort')
