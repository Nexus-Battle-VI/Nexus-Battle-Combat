/**
 * Cerrojo asincrono POR CANAL (HU-13): ejecuta de una en una las tareas de un
 * mismo canal, en el orden en que se piden. Canales distintos no se esperan.
 *
 * Es lo que hace que el orden de `seq` sea el orden de difusion y que una
 * suscripcion (leer el historial y registrarse) no pueda intercalarse con una
 * difusion: sin el, un cliente que se suscribe justo mientras se difunde un
 * mensaje podria perderlo (llega despues del historial leido y antes del
 * registro) o recibirlo dos veces.
 *
 * Solo es valido con UNA replica de Combat (ADR-020): el cerrojo vive en la
 * memoria del proceso. Con mas replicas el orden lo tendria que dar el almacen.
 *
 * Las tareas se encadenan sobre una promesa que nunca se rechaza: una tarea que
 * falla propaga su error a quien la pidio, pero no envenena a las siguientes.
 */
export class ChannelLock {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )

    this.tails.set(key, tail)

    // Sin esto el mapa acumularia una entrada por canal que se uso alguna vez.
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key)
      }
    })

    return result
  }

  /** Canales con tareas en curso o en cola. Para pruebas y diagnostico. */
  get activeChannels(): number {
    return this.tails.size
  }
}
