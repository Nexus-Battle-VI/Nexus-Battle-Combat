import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { flush } from '../fixtures/fake-socket'

/**
 * Cerrojo por canal (HU-13): el orden de `seq` es el orden de difusion, y una
 * suscripcion no se intercala con una difusion.
 */
describe('ChannelLock', () => {
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('devuelve el resultado de la tarea', async () => {
    const lock = new ChannelLock()

    await expect(lock.run('a', () => Promise.resolve(42))).resolves.toBe(42)
  })

  it('las tareas de un mismo canal se ejecutan de una en una y en el orden pedido', async () => {
    const lock = new ChannelLock()
    let running = 0
    let maxRunning = 0
    const order: number[] = []

    const runs = [...Array(10).keys()].map((i) =>
      lock.run('lobby', async () => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        await delay(i % 2 === 0 ? 8 : 1)
        order.push(i)
        running -= 1
      }),
    )

    await Promise.all(runs)

    expect(maxRunning).toBe(1)
    expect(order).toEqual([...Array(10).keys()])
  })

  it('canales distintos NO se esperan entre si', async () => {
    const lock = new ChannelLock()
    const events: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const slow = lock.run('sala-A', async () => {
      events.push('A:inicio')
      await gate
      events.push('A:fin')
    })
    const fast = lock.run('sala-B', () => {
      events.push('B')

      return Promise.resolve()
    })

    await fast
    expect(events).toEqual(['A:inicio', 'B'])

    release()
    await slow
    expect(events).toEqual(['A:inicio', 'B', 'A:fin'])
  })

  it('una tarea que falla propaga su error a quien la pidio y NO envenena a las siguientes', async () => {
    const lock = new ChannelLock()

    const failing = lock.run('c', () => Promise.reject(new Error('boom')))
    const next = lock.run('c', () => Promise.resolve('sigue'))

    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('sigue')
  })

  it('una tarea que lanza de forma sincrona tambien propaga y no bloquea al canal', async () => {
    const lock = new ChannelLock()

    const failing = lock.run('c', () => {
      throw new Error('sincrono')
    })
    const next = lock.run('c', () => Promise.resolve('ok'))

    await expect(failing).rejects.toThrow('sincrono')
    await expect(next).resolves.toBe('ok')
  })

  it('libera la entrada del canal al quedar ocioso (no acumula canales usados)', async () => {
    const lock = new ChannelLock()

    await Promise.all([
      lock.run('a', () => Promise.resolve()),
      lock.run('b', () => Promise.resolve()),
      lock.run('a', () => Promise.resolve()),
    ])
    await flush()

    expect(lock.activeChannels).toBe(0)
  })

  it('mientras hay una tarea en curso el canal figura activo', async () => {
    const lock = new ChannelLock()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const running = lock.run('a', () => gate)
    await flush()

    expect(lock.activeChannels).toBe(1)

    release()
    await running
    await flush()

    expect(lock.activeChannels).toBe(0)
  })
})
