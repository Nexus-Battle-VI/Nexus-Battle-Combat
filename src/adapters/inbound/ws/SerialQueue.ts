/**
 * Cola secuencial de tareas asincronas de UNA conexion (HU-13).
 *
 * POR QUE EXISTE. `ws` entrega cada mensaje en su propio evento y el gateway
 * los atendia sin esperar al anterior. Un cliente que envia `auth` y
 * `subscribe` seguidos (Web lo hace: `useBattleRoomRealtime`) hacia que el
 * segundo se comprobara ANTES de que la verificacion asincrona del primero
 * terminara, y la conexion se cerraba con `4401 no_autenticado`. Medido contra
 * el gateway de `develop` con un cliente `ws` real: cierre; con 100 ms de
 * separacion entre ambos mensajes, funcionaba.
 *
 * Con esta cola cada mensaje empieza cuando el anterior de la MISMA conexion
 * termino, sea cual sea el instante en que llego. Conexiones distintas no se
 * esperan entre si.
 *
 * El primer mensaje con la cola ociosa se inicia SINCRONAMENTE (no en la
 * siguiente microtarea): el comportamiento de un mensaje aislado no cambia.
 *
 * `maxPending` acota los mensajes EN ESPERA (no el que se esta atendiendo): un
 * cliente que inunda el socket no puede acumular memoria sin limite.
 */
export class SerialQueue {
  private readonly pending: (() => Promise<void>)[] = []
  private running = false

  constructor(
    private readonly maxPending: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** `false` si la cola esta llena: la tarea NO se encola y el llamador decide (cerrar la conexion). */
  push(task: () => Promise<void>): boolean {
    if (this.pending.length >= this.maxPending) {
      return false
    }

    this.pending.push(task)

    if (!this.running) {
      void this.drain()
    }

    return true
  }

  /** Tareas esperando su turno, sin contar la que se esta atendiendo. */
  get waiting(): number {
    return this.pending.length
  }

  private async drain(): Promise<void> {
    this.running = true

    try {
      for (let task = this.pending.shift(); task !== undefined; task = this.pending.shift()) {
        try {
          await task()
        } catch (error: unknown) {
          // Un fallo de un mensaje no detiene los siguientes de la conexion.
          this.onError(error)
        }
      }
    } finally {
      this.running = false
    }
  }
}
