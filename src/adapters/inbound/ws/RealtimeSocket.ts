/**
 * Lo minimo que el gateway y el chat necesitan de un socket. `ws` lo cumple
 * tal cual; las pruebas de logica lo sustituyen por un doble sin red.
 *
 * `bufferedAmount`, `ping` y `terminate` son OPCIONALES a proposito: los dobles
 * anteriores a HU-13 no los tienen y `ws` si. Donde se usan, se usan con `?.`.
 */
export interface RealtimeSocket {
  readonly readyState: number
  /** Bytes encolados y aun no escritos al cable: mide un consumidor lento. */
  readonly bufferedAmount?: number
  on(event: 'message', listener: (data: RealtimeSocketData) => void): void
  on(event: 'close' | 'pong', listener: () => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
  ping?(): void
  terminate?(): void
}

/** Lo que `ws` entrega en el evento `message`: `Buffer`, `ArrayBuffer` o similar con `toString()`. */
export interface RealtimeSocketData {
  toString(): string
}

/** `readyState` de un socket abierto (RFC 6455 / `WebSocket.OPEN`). */
export const SOCKET_OPEN = 1
