import type { RealtimeSocket } from '../../src/adapters/inbound/ws/RealtimeSocket'

type MessageListener = (data: { toString(): string }) => void

/**
 * Socket falso para probar la logica del gateway y del chat sin red (HU-13).
 *
 * Reproduce lo que importa de `ws`: `readyState`, `bufferedAmount`, que
 * `close()` dispare el evento `close` (con lo que el gateway se limpia) y que
 * un socket cerrado no entregue nada. Lo que NO reproduce (tramas reales,
 * maximo de payload, ping/pong de verdad) lo cubre la prueba de integracion con
 * `ws` real (`test/integration/chat-realtime.spec.ts`).
 */
export class FakeSocket implements RealtimeSocket {
  readyState = 1
  bufferedAmount = 0
  readonly sent: string[] = []
  readonly closeCalls: { code: number | undefined; reason: string | undefined }[] = []
  pingCount = 0
  terminated = false

  /** Si se fija, `send` lanza: simula un socket que falla a mitad de una difusion. */
  failOnSend: Error | null = null

  private messageListener: MessageListener | null = null
  private readonly closeListeners: (() => void)[] = []
  private pongListener: (() => void) | null = null

  on(event: 'message', listener: MessageListener): void
  on(event: 'close' | 'pong', listener: () => void): void
  on(event: 'message' | 'close' | 'pong', listener: MessageListener | (() => void)): void {
    if (event === 'message') {
      this.messageListener = listener
    } else if (event === 'close') {
      this.closeListeners.push(listener as () => void)
    } else {
      this.pongListener = listener as () => void
    }
  }

  send(data: string): void {
    if (this.failOnSend !== null) {
      throw this.failOnSend
    }

    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) {
      return
    }

    this.readyState = 3
    this.closeCalls.push({ code, reason })

    for (const listener of this.closeListeners) {
      listener()
    }
  }

  ping(): void {
    this.pingCount += 1
  }

  terminate(): void {
    this.terminated = true
    this.close(1006, 'terminado')
  }

  /** Simula al cliente enviando un mensaje JSON. */
  emit(payload: unknown): void {
    this.messageListener?.({ toString: () => JSON.stringify(payload) })
  }

  /** Simula al cliente enviando texto crudo (no necesariamente JSON). */
  emitRaw(raw: string): void {
    this.messageListener?.({ toString: () => raw })
  }

  emitPong(): void {
    this.pongListener?.()
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }

  framesOfType(type: string): Record<string, unknown>[] {
    return this.frames().filter((frame) => frame.type === type)
  }

  last(): Record<string, unknown> {
    const frames = this.frames()
    const last = frames[frames.length - 1]

    if (last === undefined) {
      throw new Error('el socket no envio ningun mensaje')
    }

    return last
  }

  clear(): void {
    this.sent.length = 0
  }
}

/** Cede el turno a todas las microtareas y macrotareas pendientes. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
