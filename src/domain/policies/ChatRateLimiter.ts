/**
 * Limitador de frecuencia del chat: ventana deslizante en memoria (HU-13).
 *
 * ADR-020 dice que «el limite de longitud y frecuencia del chat lo fija
 * HU-13», y la Historia no da cifras. La cifra por defecto (5 mensajes cada
 * 10 segundos, por remitente y canal) es una propuesta ratificada por el PO
 * por chat, no consta por escrito; por eso es configuracion, no una constante.
 *
 * Ventana deslizante, no ventana fija: con una fija, un remitente podria
 * enviar `max` mensajes al final de una ventana y `max` al principio de la
 * siguiente (el doble de lo permitido en un instante).
 *
 * Solo memoria del proceso: Combat corre en UNA replica (ADR-020). Con mas
 * replicas cada una contaria por su cuenta y el limite efectivo se
 * multiplicaria; escalar exigiria un almacen compartido.
 *
 * El tiempo entra como argumento (`nowMs`), no se lee aqui: asi la politica es
 * determinista y las pruebas de frontera no falsean temporizadores.
 */
export class ChatRateLimiter {
  private readonly attempts = new Map<string, number[]>()
  private callsSinceSweep = 0

  constructor(
    private readonly maxMessages: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new RangeError('El maximo de mensajes por ventana debe ser un entero >= 1.')
    }

    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new RangeError('La ventana del limitador debe ser un entero de milisegundos >= 1.')
    }
  }

  /**
   * Intenta reservar un hueco para `key` en `nowMs`. Devuelve `0` si el envio
   * esta permitido (y lo registra) o los milisegundos que faltan para que se
   * libere el siguiente hueco, siempre >= 1, si no lo esta (y no registra
   * nada: un intento rechazado no consume cupo).
   */
  tryAcquire(key: string, nowMs: number): number {
    this.sweepOccasionally(nowMs)

    const cutoff = nowMs - this.windowMs
    const recent = (this.attempts.get(key) ?? []).filter((timestamp) => timestamp > cutoff)

    if (recent.length >= this.maxMessages) {
      this.attempts.set(key, recent)

      // `recent` esta ordenado: el primero es el que sale antes de la ventana.
      const oldest = recent[0] ?? nowMs

      return oldest + this.windowMs - nowMs
    }

    recent.push(nowMs)
    this.attempts.set(key, recent)

    return 0
  }

  /** Claves con intentos aun dentro de la ventana. Para pruebas y diagnostico. */
  get trackedKeys(): number {
    return this.attempts.size
  }

  /**
   * Elimina las claves cuya ultima actividad ya salio de la ventana. Sin esto
   * el mapa crece con cada remitente distinto y nunca se libera. Es amortizado:
   * se ejecuta cada 1024 llamadas, no en cada una.
   */
  private sweepOccasionally(nowMs: number): void {
    this.callsSinceSweep += 1

    if (this.callsSinceSweep < 1024) {
      return
    }

    this.callsSinceSweep = 0
    const cutoff = nowMs - this.windowMs

    for (const [key, timestamps] of this.attempts) {
      const last = timestamps[timestamps.length - 1]

      if (last === undefined || last <= cutoff) {
        this.attempts.delete(key)
      }
    }
  }
}
