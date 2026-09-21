import type { BattleEvent } from '../../domain/entities/BattleEvent'

/**
 * Puerto de salida para difundir eventos de batalla con `seq` (HU-17,
 * ADR-020) a los participantes de una sala.
 *
 * REGLA DE ORDEN (ADR-020): se invoca SIEMPRE DESPUES de que el repositorio
 * persistio la batalla y el evento. Nunca antes: un cliente no debe recibir un
 * evento cuyo estado no existe. Un fallo al difundir no revierte ni falla la
 * operacion: el estado ya esta persistido y un cliente que se lo pierda lo
 * recupera con `resume`.
 *
 * Los eventos se entregan SOLO a los participantes de la sala (un
 * espectador o cualquier otro jugador no los recibe).
 */
export interface BattleEventPublisherPort {
  publish(roomId: string, events: readonly BattleEvent[]): void
}

export const BATTLE_EVENT_PUBLISHER = Symbol('BattleEventPublisherPort')
