import { SerialQueue } from '../../src/adapters/inbound/ws/SerialQueue'
import { flush } from '../fixtures/fake-socket'

/**
 * Cola secuencial por conexion (HU-13): la causa de la carrera medida entre
 * `auth` y `subscribe` era atender los mensajes de una conexion sin esperar al
 * anterior.
 */
describe('SerialQueue', () => {
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('la primera tarea con la cola ociosa empieza SINCRONAMENTE', () => {
    const queue = new SerialQueue(8, () => undefined)
    let started = false

    queue.push(() => {
      started = true

      return Promise.resolve()
    })

    expect(started).toBe(true)
  })

  it('una tarea no empieza hasta que termina la anterior, aunque llegue de inmediato', async () => {
    const queue = new SerialQueue(8, () => undefined)
    const events: string[] = []

    queue.push(async () => {
      events.push('1:inicio')
      await delay(30)
      events.push('1:fin')
    })
    queue.push(() => {
      events.push('2:inicio')

      return Promise.resolve()
    })

    await flush()
    expect(events).toEqual(['1:inicio'])

    await delay(60)
    expect(events).toEqual(['1:inicio', '1:fin', '2:inicio'])
  })

  it('nunca hay dos tareas en curso a la vez y el orden es el de llegada', async () => {
    const queue = new SerialQueue(50, () => undefined)
    let running = 0
    let maxRunning = 0
    const order: number[] = []

    const allDone = new Promise<void>((resolve) => {
      for (let i = 0; i < 20; i += 1) {
        queue.push(async () => {
          running += 1
          maxRunning = Math.max(maxRunning, running)
          await delay(i % 3)
          order.push(i)
          running -= 1

          if (order.length === 20) {
            resolve()
          }
        })
      }
    })

    await allDone

    expect(maxRunning).toBe(1)
    expect(order).toEqual([...Array(20).keys()])
  })

  it('una tarea que falla se notifica y NO detiene las siguientes', async () => {
    const errors: unknown[] = []
    const queue = new SerialQueue(8, (error) => errors.push(error))
    const ran: string[] = []

    queue.push(() => Promise.reject(new Error('fallo')))
    queue.push(() => {
      ran.push('segunda')

      return Promise.resolve()
    })

    await flush()

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('fallo')
    expect(ran).toEqual(['segunda'])
  })

  it('una tarea que lanza de forma sincrona tambien se notifica y la cola sigue', async () => {
    const errors: unknown[] = []
    const queue = new SerialQueue(8, (error) => errors.push(error))
    const ran: string[] = []

    queue.push(() => {
      throw new Error('sincrono')
    })
    queue.push(() => {
      ran.push('siguiente')

      return Promise.resolve()
    })

    await flush()

    expect(errors).toHaveLength(1)
    expect(ran).toEqual(['siguiente'])
  })

  describe('limite de mensajes en espera', () => {
    it('frontera: acepta `maxPending` en espera y rechaza la siguiente', async () => {
      const queue = new SerialQueue(3, () => undefined)
      let release: () => void = () => undefined
      const blocker = new Promise<void>((resolve) => {
        release = resolve
      })

      // La primera se atiende (no cuenta como en espera) y bloquea la cola.
      expect(queue.push(() => blocker)).toBe(true)

      expect(queue.push(() => Promise.resolve())).toBe(true)
      expect(queue.push(() => Promise.resolve())).toBe(true)
      expect(queue.push(() => Promise.resolve())).toBe(true)
      expect(queue.waiting).toBe(3)

      expect(queue.push(() => Promise.resolve())).toBe(false)
      expect(queue.waiting).toBe(3)

      release()
      await flush()
      expect(queue.waiting).toBe(0)
    })

    it('una tarea rechazada NO se ejecuta nunca; la aceptada en espera SI', async () => {
      const queue = new SerialQueue(1, () => undefined)
      let release: () => void = () => undefined
      const blocker = new Promise<void>((resolve) => {
        release = resolve
      })
      const ran: string[] = []

      expect(queue.push(() => blocker)).toBe(true)
      expect(
        queue.push(() => {
          ran.push('en espera')

          return Promise.resolve()
        }),
      ).toBe(true)
      expect(
        queue.push(() => {
          ran.push('rechazada')

          return Promise.resolve()
        }),
      ).toBe(false)

      release()
      await flush()

      expect(ran).toEqual(['en espera'])
    })

    it('con maxPending 0 ninguna tarea entra: el limite cuenta las que esperan su turno', () => {
      const queue = new SerialQueue(0, () => undefined)

      expect(queue.push(() => Promise.resolve())).toBe(false)
    })

    it('tras vaciarse vuelve a aceptar', async () => {
      const queue = new SerialQueue(1, () => undefined)

      queue.push(() => Promise.resolve())
      await flush()

      expect(queue.push(() => Promise.resolve())).toBe(true)
    })
  })
})
