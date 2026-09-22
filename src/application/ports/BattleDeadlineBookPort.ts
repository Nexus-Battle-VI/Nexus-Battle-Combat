/**
 * Libro de vencimientos por sala (HU-21, contrato §3). El planificador registra
 * cuando hay que despertar a una sala; el barrido de 1 s procesa solo las que
 * vencieron.
 *
 * Es deliberadamente tonto: no conoce la batalla ni el reloj. Guarda un instante
 * por sala con dos semantias:
 *  - `ensureDueBy` CONSERVA el mas temprano (el primer vencimiento pendiente no
 *    se pospone nunca solo porque llegue otro mas tardio).
 *  - `setDue` REEMPLAZA (tras liquidar, la sala reprograma su proximo
 *    vencimiento real).
 */
export interface BattleDeadlineBookPort {
  /** Registra que la sala tiene un vencimiento en `dueAt`; conserva el mas temprano. */
  ensureDueBy(roomId: string, dueAt: Date): void

  /** Fija el proximo vencimiento de la sala (lo que devuelve `nextDueAt`). */
  setDue(roomId: string, dueAt: Date): void

  /** La sala no tiene vencimientos pendientes (termino o desaparecio). */
  cancel(roomId: string): void

  /** Salas cuyo vencimiento ya llego (`dueAt <= now`). */
  dueRooms(now: Date): readonly string[]
}

export const BATTLE_DEADLINE_BOOK = Symbol('BattleDeadlineBookPort')
