import { IntervalBattleDeadlineScheduler } from '../../src/adapters/outbound/system/IntervalBattleDeadlineScheduler'
import type { BattleDeadlineBookPort } from '../../src/application/ports/BattleDeadlineBookPort'
import type { ProcessBattleDeadlines } from '../../src/application/use-cases/ProcessBattleDeadlines'
import type { RecoverBattleDeadlines } from '../../src/application/use-cases/RecoverBattleDeadlines'
import { NOW, silentLogger } from '../fixtures/battle'
import { memoryBook } from '../fixtures/finalization'

/** Reloj fijo: `tick()` lee `clock.now()` una vez por pasada. */
const clock = { now: () => new Date(NOW.getTime()) }

/**
 * Barrido de vencimientos (HU-21, contrato §3): cada tick procesa SOLO lo vencido,
 * un fallo no detiene a las demas y `bootstrap` recupera antes de arrancar.
 */
const schedulerWith = (
  process: ProcessBattleDeadlines,
  book: BattleDeadlineBookPort,
  recover: RecoverBattleDeadlines,
  errors: Record<string, unknown>[] = [],
) =>
  new IntervalBattleDeadlineScheduler(book, process, recover, clock, {
    ...silentLogger,
    error: (_message: string, context: Record<string, string | number | boolean | null> = {}) => {
      errors.push(context)
    },
  })

const fakeProcess = (
  handler: (roomId: string) => Promise<void>,
): ProcessBattleDeadlines & { readonly calls: string[] } => {
  const calls: string[] = []

  return {
    calls,
    execute: async (roomId: string) => {
      calls.push(roomId)

      await handler(roomId)
    },
  } as unknown as ProcessBattleDeadlines & { readonly calls: string[] }
}

const fakeRecover = (
  rooms: number,
): { readonly recover: RecoverBattleDeadlines; readonly spy: jest.Mock } => {
  const spy = jest.fn(() => Promise.resolve(rooms))

  return { recover: { execute: spy } as unknown as RecoverBattleDeadlines, spy }
}

describe('IntervalBattleDeadlineScheduler — tick()', () => {
  it('procesa solo las salas vencidas y reprograma su siguiente vencimiento', async () => {
    const book = memoryBook()
    const process = fakeProcess(() => Promise.resolve())

    book.ensureDueBy('sala-vencida', new Date(NOW.getTime() - 1))
    book.ensureDueBy('sala-futura', new Date(NOW.getTime() + 60_000))

    const scheduler = schedulerWith(process, book, fakeRecover(0).recover)

    await expect(scheduler.tick()).resolves.toBe(1)

    expect(process.calls).toEqual(['sala-vencida'])
    // Tras procesar, la sala espera un tick antes de volver a ser candidata.
    expect(book.dueRooms(clock.now())).toEqual([])
    expect(book.dueRooms(new Date(clock.now().getTime() + 1_000))).toEqual(['sala-vencida'])
  })

  it('no reentra una sala que ya se esta procesando', async () => {
    const book = memoryBook()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const process = fakeProcess(() => gate)

    // El libro siempre la considera vencida: el filtro que se prueba es `inFlight`.
    book.dueRooms = () => ['sala-lenta']

    const scheduler = schedulerWith(process, book, fakeRecover(0).recover)
    const first = scheduler.tick()
    const second = await scheduler.tick()

    expect(second).toBe(0)
    expect(process.calls).toEqual(['sala-lenta'])

    release()
    await expect(first).resolves.toBe(1)
  })

  it('un fallo en una sala NO detiene a las demas y queda registrado', async () => {
    const book = memoryBook()
    const errors: Record<string, unknown>[] = []
    const process = fakeProcess((roomId) => {
      if (roomId === 'sala-rota') {
        return Promise.reject(new Error('boom'))
      }

      return Promise.resolve()
    })

    book.ensureDueBy('sala-rota', new Date(NOW.getTime() - 2))
    book.ensureDueBy('sala-ok', new Date(NOW.getTime() - 1))

    const scheduler = schedulerWith(process, book, fakeRecover(0).recover, errors)

    await expect(scheduler.tick()).resolves.toBe(1)

    expect(process.calls).toEqual(['sala-rota', 'sala-ok'])
    expect(errors[0]).toMatchObject({ roomId: 'sala-rota', reason: 'Error' })
  })
})

describe('IntervalBattleDeadlineScheduler — arranque y parada', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('bootstrap recupera los vencimientos y, con autoStart:false, no deja temporizador', async () => {
    jest.useFakeTimers()

    const { recover, spy } = fakeRecover(3)
    const scheduler = new IntervalBattleDeadlineScheduler(
      memoryBook(),
      fakeProcess(() => Promise.resolve()),
      recover,
      clock,
      silentLogger,
      { autoStart: false, tickMs: 1_000 },
    )

    await scheduler.onApplicationBootstrap()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('con autoStart:true arranca el intervalo y `shutdown` lo limpia', async () => {
    jest.useFakeTimers()

    const book = memoryBook()
    const process = fakeProcess(() => Promise.resolve())

    book.ensureDueBy('sala', new Date(NOW.getTime()))

    const scheduler = new IntervalBattleDeadlineScheduler(
      book,
      process,
      fakeRecover(0).recover,
      clock,
      silentLogger,
      { autoStart: true, tickMs: 1_000 },
    )

    await scheduler.onApplicationBootstrap()

    expect(jest.getTimerCount()).toBe(1)

    await jest.advanceTimersByTimeAsync(1_000)

    expect(process.calls).toEqual(['sala'])

    scheduler.onApplicationShutdown()

    expect(jest.getTimerCount()).toBe(0)
  })
})
