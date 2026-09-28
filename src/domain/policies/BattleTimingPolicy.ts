/**
 * Temporizadores de la batalla (HU-21, contrato `hu-21-battle-finish-v1`, §3).
 *
 * Las tres duraciones son CONSTANTES del dominio: el contrato prohibe
 * variables de entorno que las cambien, para que el comportamiento sea el
 * mismo en todos los entornos y las pruebas puedan fijarlo con `ClockPort` y
 * un `tick()` manual.
 *
 * Este modulo es puro y NO lee el reloj: recibe una fecha ya resuelta
 * (`ClockPort` en la capa de aplicacion) y devuelve otra fecha. Es tambien el
 * unico archivo de la HU autorizado a construir fechas derivadas con
 * `new Date(x.getTime() + ms)`: el desplazamiento de una fecha ya recibida no
 * es una lectura del reloj del sistema.
 */

/** Temporizador global de la batalla (contrato §3): 6 minutos. */
export const BATTLE_TIME_LIMIT_MS = 360_000 as const

/** Temporizador de un turno (contrato §3): 30 segundos. */
export const TURN_TIME_LIMIT_MS = 30_000 as const

/** Gracia de reconexion tras perder la ultima conexion de batalla (D1): 30 segundos. */
export const DISCONNECT_GRACE_MS = 30_000 as const

/** Instante en que vence el temporizador global, a partir del inicio de la batalla. */
export const battleDeadline = (startedAt: Date): Date =>
  new Date(startedAt.getTime() + BATTLE_TIME_LIMIT_MS)

/** Instante en que vence el turno vigente, a partir de su inicio. */
export const turnDeadline = (turnStartedAt: Date): Date =>
  new Date(turnStartedAt.getTime() + TURN_TIME_LIMIT_MS)

/** Instante en que vence la gracia de un participante ausente desde `absentSince`. */
export const graceDeadline = (absentSince: Date): Date =>
  new Date(absentSince.getTime() + DISCONNECT_GRACE_MS)

/**
 * Instante en que vence el compromiso de equipamiento de una batalla (HU-29).
 *
 * Es el vencimiento de la batalla MAS la gracia de reconexion: el compromiso debe
 * sobrevivir a la batalla para que nadie pueda cambiar el equipamiento miembro a
 * miembro, y su unico proposito es acotar el peor caso (bloqueo sin liberacion
 * explicita). No se define una duracion nueva: se reutilizan las dos constantes.
 */
export const commitmentExpiresAt = (startedAt: Date): Date =>
  new Date(battleDeadline(startedAt).getTime() + DISCONNECT_GRACE_MS)

/**
 * El limite es INCLUSIVO (contrato §3): en el instante exacto del vencimiento ya
 * vencio. La frontera es `deadline - 1 ms` no vence; `deadline` si.
 */
export const hasReached = (now: Date, deadline: Date): boolean =>
  now.getTime() >= deadline.getTime()
