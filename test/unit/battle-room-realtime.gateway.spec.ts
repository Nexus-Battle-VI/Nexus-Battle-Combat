import 'reflect-metadata'

import type { BasicAttackRealtimeHandler } from '../../src/adapters/inbound/ws/BasicAttackRealtimeHandler'
import {
  AUTH_TIMEOUT_MS,
  BattleRoomRealtimeGateway,
  HEARTBEAT_INTERVAL_MS,
  MAX_MESSAGE_BYTES,
} from '../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import type { ChatRealtimeHandler } from '../../src/adapters/inbound/ws/ChatRealtimeHandler'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryRealtimeTicketStore } from '../../src/adapters/outbound/realtime/InMemoryRealtimeTicketStore'
import type { RealtimeTicketCodecPort } from '../../src/application/ports/RealtimeTicketPort'
import { CompleteBattleTurn } from '../../src/application/use-cases/CompleteBattleTurn'
import {
  ConsumeRealtimeTicket,
  IssueRealtimeTicket,
} from '../../src/application/use-cases/RealtimeTickets'
import { ResumeBattle } from '../../src/application/use-cases/ResumeBattle'
import { ROOM_ID, clock, inBattleRoom, preparingRoom, silentLogger } from '../fixtures/battle'

/**
 * Gateway WebSocket de Combat (ADR-020, HU-17): ticket de un solo uso, `seq`,
 * `resume`, difusion solo a participantes y latido. Se ejercita con un socket
 * FALSO: la logica de autenticacion, suscripcion y difusion es independiente
 * del transporte concreto. El protocolo real sobre `ws` lo cubre
 * `test/db/battle-realtime.e2e.spec.ts`.
 */
type MessageListener = (data: { toString(): string }) => void

class FakeSocket {
  readyState = 1
  readonly sent: string[] = []
  readonly closeCalls: { code?: number; reason?: string }[] = []
  pings = 0
  terminated = false
  private readonly listeners: { message?: MessageListener; close?: () => void; pong?: () => void } =
    {}

  on(event: 'message' | 'close' | 'pong', listener: MessageListener | (() => void)): void {
    this.listeners[event] = listener as never
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.closeCalls.push({ code, reason })
    this.listeners.close?.()
  }

  ping(): void {
    this.pings += 1
  }

  terminate(): void {
    this.terminated = true
    this.readyState = 3
    this.listeners.close?.()
  }

  emit(payload: unknown): void {
    this.listeners.message?.({ toString: () => JSON.stringify(payload) })
  }

  emitRaw(raw: string): void {
    this.listeners.message?.({ toString: () => raw })
  }

  pong(): void {
    this.listeners.pong?.()
  }

  messages(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }

  lastSent(): Record<string, unknown> {
    const last = this.messages().at(-1)

    if (last === undefined) {
      throw new Error('el socket no envio ningun mensaje')
    }

    return last
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

const codec: RealtimeTicketCodecPort = {
  generate: (() => {
    let counter = 0

    return () => `ticket-${String((counter += 1))}`
  })(),
  hash: (ticket) => `h:${ticket}`,
}

/**
 * Esta suite prueba tickets, `seq`, `resume` y latido, no el chat (HU-13): el
 * manejador de chat es un doble inerte. El chat sobre el gateway real lo cubren
 * `chat-gateway.spec.ts` y `test/integration/chat-realtime.spec.ts`.
 */
const noChat = {
  handle: jest.fn().mockResolvedValue(undefined),
  onDisconnect: jest.fn(),
  onRoomUpdated: jest.fn().mockResolvedValue(undefined),
} as unknown as ChatRealtimeHandler

/** El ataque basico (HU-18) tiene su propia suite: aqui el gateway no lo ejerce. */
const noAttack = { handle: jest.fn() } as unknown as BasicAttackRealtimeHandler

const world = (resume?: (repo: InMemoryBattleRoomRepository) => ResumeBattle) => {
  const repo = new InMemoryBattleRoomRepository()
  const store = new InMemoryRealtimeTicketStore()
  const issue = new IssueRealtimeTicket(codec, store, clock)
  const gateway = new BattleRoomRealtimeGateway(
    new ConsumeRealtimeTicket(codec, store, clock),
    repo,
    resume?.(repo) ?? new ResumeBattle(repo),
    silentLogger,
    noChat,
    noAttack,
  )

  const connect = async (subject: string | null): Promise<FakeSocket> => {
    const socket = new FakeSocket()

    gateway.handleConnection(socket)

    if (subject !== null) {
      socket.emit({ type: 'auth', ticket: issue.execute(subject).ticket })
      await flush()
    }

    return socket
  }

  return { repo, gateway, issue, connect }
}

afterEach(() => {
  jest.useRealTimers()
})

describe('BattleRoomRealtimeGateway — autenticacion por ticket (ADR-020)', () => {
  it('un ticket valido autentica: auth.ok y la conexion queda abierta', async () => {
    const { connect } = world()
    const socket = await connect('a1')

    expect(socket.lastSent()).toEqual({ type: 'auth.ok' })
    expect(socket.closeCalls).toEqual([])
  })

  it('un ticket USADO cierra con 4401: el segundo intento con el mismo ticket falla', async () => {
    const { gateway, issue } = world()
    const { ticket } = issue.execute('a1')
    const first = new FakeSocket()
    const second = new FakeSocket()

    gateway.handleConnection(first)
    first.emit({ type: 'auth', ticket })
    await flush()
    gateway.handleConnection(second)
    second.emit({ type: 'auth', ticket })
    await flush()

    expect(first.lastSent()).toEqual({ type: 'auth.ok' })
    expect(second.closeCalls[0]?.code).toBe(4401)
  })

  it.each([
    ['incorrecto', { type: 'auth', ticket: 'inventado' }],
    ['ausente', { type: 'auth' }],
    ['de otro tipo', { type: 'auth', ticket: 123 }],
    ['el JWT del esquema antiguo', { type: 'auth', token: 'eyJhbGciOi...' }],
  ])('un ticket %s cierra con 4401 y no autentica', async (_case, message) => {
    const { gateway } = world()
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emit(message)
    await flush()

    expect(socket.closeCalls[0]?.code).toBe(4401)
    expect(socket.sent).toEqual([])
  })

  it('un ticket CADUCADO cierra con 4401', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const store = new InMemoryRealtimeTicketStore()
    const past = { now: () => new Date(clock.now().getTime() - 60_000) }
    const gateway = new BattleRoomRealtimeGateway(
      new ConsumeRealtimeTicket(codec, store, clock),
      repo,
      new ResumeBattle(repo),
      silentLogger,
      noChat,
      noAttack,
    )
    const { ticket } = new IssueRealtimeTicket(codec, store, past).execute('a1')
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emit({ type: 'auth', ticket })
    await flush()

    expect(socket.closeCalls[0]?.code).toBe(4401)
  })

  it('sin ticket en 5 s se cierra con 4401 (auth_timeout)', () => {
    jest.useFakeTimers()
    const { gateway } = world()
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    jest.advanceTimersByTime(AUTH_TIMEOUT_MS - 1)

    expect(socket.closeCalls).toEqual([])

    jest.advanceTimersByTime(1)

    expect(socket.closeCalls).toEqual([{ code: 4401, reason: 'auth_timeout' }])
    expect(AUTH_TIMEOUT_MS).toBe(5_000)
  })

  it('autenticarse a tiempo cancela el temporizador de 5 s', async () => {
    jest.useFakeTimers()
    const { connect } = world()
    const socket = await connect('a1')

    jest.advanceTimersByTime(AUTH_TIMEOUT_MS * 3)

    expect(socket.closeCalls).toEqual([])
  })

  it('una conexion autenticada NO puede cambiar de identidad con un segundo auth', async () => {
    const { connect, issue } = world()
    const socket = await connect('a1')

    socket.emit({ type: 'auth', ticket: issue.execute('b1').ticket })
    await flush()

    expect(socket.lastSent()).toEqual({ type: 'command.rejected', code: 'ALREADY_AUTHENTICATED' })
    expect(socket.closeCalls).toEqual([])
  })

  it('subscribe o resume ANTES de autenticar -> 4401', async () => {
    for (const message of [
      { type: 'subscribe', roomId: ROOM_ID },
      { type: 'resume', roomId: ROOM_ID },
    ]) {
      const { gateway } = world()
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emit(message)
      await flush()

      expect(socket.closeCalls[0]?.code).toBe(4401)
    }
  })

  it.each(['no es json', '[1,2]', '"texto"', '{"sin":"type"}'])(
    'mensaje malformado (%s) -> 4400',
    async (raw) => {
      const { gateway } = world()
      const socket = new FakeSocket()

      gateway.handleConnection(socket)
      socket.emitRaw(raw)
      await flush()

      expect(socket.closeCalls[0]?.code).toBe(4400)
    },
  )

  it('un tipo de mensaje desconocido cierra con 4400; el limite de tamano de ADR-020 son 16 KiB', async () => {
    const { connect } = world()
    const socket = await connect('a1')

    // `attack` (HU-18) ya es un comando conocido; `useSkill` es de HU-19 y sigue sin reconocerse.
    socket.emit({ type: 'useSkill', commandId: 'x' })
    await flush()

    expect(socket.closeCalls[0]?.code).toBe(4400)
    expect(MAX_MESSAGE_BYTES).toBe(16_384)
  })
})

describe('BattleRoomRealtimeGateway — lobby (subscribe, HU-15.2)', () => {
  it('suscripcion a una sala existente responde subscribe.ok', async () => {
    const { connect, repo } = world()

    await repo.save(preparingRoom(), 0)
    const socket = await connect('a1')

    socket.emit({ type: 'subscribe', roomId: ROOM_ID })
    await flush()

    expect(socket.lastSent()).toEqual({ type: 'subscribe.ok', roomId: ROOM_ID })
  })

  it('una sala inexistente no se suscribe en silencio', async () => {
    const { connect } = world()
    const socket = await connect('a1')

    socket.emit({ type: 'subscribe', roomId: 'no-existe' })
    await flush()

    expect(socket.closeCalls[0]?.code).toBe(4400)
  })

  it('battle-room.updated solo llega a suscritos a ESA sala y con el payload minimo', async () => {
    const { connect, repo, gateway } = world()
    const otra = '22222222-2222-4222-8222-222222222222'

    await repo.save(preparingRoom(), 0)
    await repo.save(preparingRoom({ id: otra }), 0)
    const enA = await connect('a1')
    const enB = await connect('b1')

    enA.emit({ type: 'subscribe', roomId: ROOM_ID })
    enB.emit({ type: 'subscribe', roomId: otra })
    await flush()

    gateway.notifyRoomUpdated({ roomId: otra, status: 'IN_BATTLE', version: 3 })

    expect(enA.messages().filter((m) => m.type === 'battle-room.updated')).toHaveLength(0)
    expect(enB.lastSent()).toEqual({
      type: 'battle-room.updated',
      roomId: otra,
      status: 'IN_BATTLE',
      version: 3,
    })
  })

  it('tras cerrar, ya no se escribe en ese socket', async () => {
    const { connect, repo, gateway } = world()

    await repo.save(preparingRoom(), 0)
    const socket = await connect('a1')

    socket.emit({ type: 'subscribe', roomId: ROOM_ID })
    await flush()
    socket.close()
    socket.sent.length = 0
    gateway.notifyRoomUpdated({ roomId: ROOM_ID, status: 'PREPARING', version: 2 })

    expect(socket.sent).toEqual([])
  })
})

describe('BattleRoomRealtimeGateway — batalla: battleStarted, seq, resume y snapshot (HU-17)', () => {
  const setup = async () => {
    const context = world()

    await context.repo.save(inBattleRoom(), 0)

    return context
  }

  it('resume de un participante sin lastSeq: snapshot completo y resume.ok', async () => {
    const { connect } = await setup()
    const socket = await connect('a1')

    socket.emit({ type: 'resume', roomId: ROOM_ID })
    await flush()

    const [auth, snapshot, ok] = socket.messages()

    expect(auth).toEqual({ type: 'auth.ok' })
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      roomId: ROOM_ID,
      seq: 1,
      status: 'IN_BATTLE',
    })
    expect(ok).toEqual({ type: 'resume.ok', roomId: ROOM_ID, seq: 1 })
  })

  it('resume con lastSeq: REENVIA en orden los eventos posteriores (replay) y termina con resume.ok', async () => {
    const { connect, repo } = await setup()
    const useCase = new CompleteBattleTurn(repo, clock, { publish: () => undefined })

    for (const [index, actor] of ['a1', 'b1', 'a1'].entries()) {
      await useCase.execute({
        roomId: ROOM_ID,
        actorPlayerId: actor,
        commandId: `c-${String(index)}`,
      })
    }

    const socket = await connect('b1')

    socket.emit({ type: 'resume', roomId: ROOM_ID, lastSeq: 2 })
    await flush()

    const received = socket.messages().slice(1)

    expect(received.map((message) => message.type)).toEqual([
      'turnAdvanced',
      'turnAdvanced',
      'resume.ok',
    ])
    expect(received.map((message) => message.seq)).toEqual([3, 4, 4])
  })

  it('un no participante NO puede hacer resume: command.rejected y no queda suscrito', async () => {
    const { connect, gateway, repo } = await setup()
    const intruso = await connect('intruso')

    intruso.emit({ type: 'resume', roomId: ROOM_ID })
    await flush()

    expect(intruso.lastSent()).toEqual({ type: 'command.rejected', code: 'NOT_A_PARTICIPANT' })

    const room = await repo.findById(ROOM_ID)

    gateway.publish(ROOM_ID, room?.events ?? [])

    expect(intruso.messages().map((message) => message.type)).toEqual([
      'auth.ok',
      'command.rejected',
    ])
  })

  it('resume de una sala inexistente -> command.rejected ROOM_NOT_FOUND', async () => {
    const { connect } = await setup()
    const socket = await connect('a1')

    socket.emit({ type: 'resume', roomId: '00000000-0000-4000-8000-000000000009' })
    await flush()

    expect(socket.lastSent()).toEqual({ type: 'command.rejected', code: 'ROOM_NOT_FOUND' })
  })

  it('battleStarted llega a AMBOS participantes con el MISMO payload y el mismo seq', async () => {
    const { connect, gateway, repo } = await setup()
    const a = await connect('a1')
    const b = await connect('b1')

    a.emit({ type: 'resume', roomId: ROOM_ID })
    b.emit({ type: 'resume', roomId: ROOM_ID })
    await flush()
    a.sent.length = 0
    b.sent.length = 0

    gateway.publish(ROOM_ID, (await repo.findById(ROOM_ID))?.events ?? [])

    expect(a.sent).toHaveLength(1)
    expect(b.sent).toEqual(a.sent)
    expect(a.lastSent()).toMatchObject({ type: 'battleStarted', seq: 1, roomId: ROOM_ID })
  })

  it('un no participante y un suscrito solo al lobby NO reciben battleStarted', async () => {
    const { connect, gateway, repo } = await setup()
    const intruso = await connect('intruso')
    const lobby = await connect('a1')

    intruso.emit({ type: 'subscribe', roomId: ROOM_ID })
    lobby.emit({ type: 'subscribe', roomId: ROOM_ID })
    await flush()
    intruso.sent.length = 0
    lobby.sent.length = 0

    gateway.publish(ROOM_ID, (await repo.findById(ROOM_ID))?.events ?? [])

    expect(intruso.sent).toEqual([])
    expect(lobby.sent).toEqual([])
  })

  it('el mensaje de batalla no contiene semilla, estado del generador ni datos internos', async () => {
    const { connect, gateway, repo } = await setup()
    const socket = await connect('a1')

    socket.emit({ type: 'resume', roomId: ROOM_ID })
    await flush()
    socket.sent.length = 0
    gateway.publish(ROOM_ID, (await repo.findById(ROOM_ID))?.events ?? [])

    expect(socket.sent[0]).not.toMatch(/seed|semilla|mt19937|state|draw|jwt|ticket|hash/i)
  })

  it('una conexion cerrada deja de recibir eventos de batalla', async () => {
    const { connect, gateway, repo } = await setup()
    const socket = await connect('a1')

    socket.emit({ type: 'resume', roomId: ROOM_ID })
    await flush()
    socket.close()
    socket.sent.length = 0
    gateway.publish(ROOM_ID, (await repo.findById(ROOM_ID))?.events ?? [])

    expect(socket.sent).toEqual([])
  })
})

/**
 * Carrera de `resume` (ADR-020: reconexion SIN perdida de eventos). `GatedResume`
 * lee el estado con el caso de uso REAL y luego se detiene hasta que el test lo
 * libera: reproduce exactamente la ventana entre "leer seq N" y "quedar
 * suscrito", en la que otro request puede persistir y publicar `N + 1`.
 */
class GatedResume extends ResumeBattle {
  private release: () => void = () => undefined
  private readSignal: () => void = () => undefined
  readonly read = new Promise<void>((resolve) => {
    this.readSignal = resolve
  })
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })

  override async execute(
    ...args: Parameters<ResumeBattle['execute']>
  ): ReturnType<ResumeBattle['execute']> {
    const result = await super.execute(...args)

    this.readSignal()
    await this.gate

    return result
  }

  open(): void {
    this.release()
  }
}

describe('BattleRoomRealtimeGateway — resume sin perdida de eventos (carrera lectura/suscripcion)', () => {
  const advance = (
    repo: InMemoryBattleRoomRepository,
    gateway: BattleRoomRealtimeGateway,
    actor: string,
    commandId: string,
  ) =>
    new CompleteBattleTurn(repo, clock, gateway).execute({
      roomId: ROOM_ID,
      actorPlayerId: actor,
      commandId,
    })

  const setup = async () => {
    let gated: GatedResume | undefined
    const context = world((repo) => (gated = new GatedResume(repo)))

    await context.repo.save(inBattleRoom(), 0)

    if (gated === undefined) {
      throw new Error('no se creo el resume con compuerta')
    }

    return { ...context, gated }
  }

  it('un evento persistido y publicado DESPUES de leer seq N y ANTES de suscribirse NO se pierde', async () => {
    const { connect, repo, gateway, gated } = await setup()

    await advance(repo, gateway, 'a1', 'c-1') // seq 2
    await advance(repo, gateway, 'b1', 'c-2') // seq 3

    const socket = await connect('b1')

    socket.emit({ type: 'resume', roomId: ROOM_ID, lastSeq: 1 })
    await gated.read // el resume ya leyo seq 3 y aun NO esta suscrito

    await advance(repo, gateway, 'a1', 'c-3') // seq 4: persiste y publica EN LA VENTANA
    gated.open()
    await flush()

    const received = socket.messages().slice(1)

    expect(received.map((message) => message.type)).toEqual([
      'turnAdvanced',
      'turnAdvanced',
      'turnAdvanced',
      'resume.ok',
    ])
    expect(received.map((message) => message.seq)).toEqual([2, 3, 4, 4])
  })

  it('tras el resume, los eventos posteriores siguen llegando en caliente y en orden', async () => {
    const { connect, repo, gateway, gated } = await setup()
    const socket = await connect('b1')

    socket.emit({ type: 'resume', roomId: ROOM_ID })
    await gated.read
    gated.open()
    await flush()
    socket.sent.length = 0

    await advance(repo, gateway, 'a1', 'c-1')
    await advance(repo, gateway, 'b1', 'c-2')

    expect(socket.messages().map((message) => message.seq)).toEqual([2, 3])
  })

  it('un evento con seq <= al leido (ya incluido en la lectura) NO se duplica', async () => {
    const { connect, repo, gateway, gated } = await setup()

    await advance(repo, gateway, 'a1', 'c-1') // seq 2

    const socket = await connect('b1')

    socket.emit({ type: 'resume', roomId: ROOM_ID, lastSeq: 1 })
    await gated.read

    // Se publica de nuevo el seq 2 (ya incluido en la lectura) y DESPUES ocurre un
    // evento nuevo (seq 3): el duplicado se ignora y el nuevo NO se pierde.
    gateway.publish(ROOM_ID, (await repo.findById(ROOM_ID))?.eventsAfter(1) ?? [])
    await advance(repo, gateway, 'b1', 'c-2') // seq 3
    gated.open()
    await flush()

    expect(
      socket
        .messages()
        .slice(1)
        .map((message) => [message.type, message.seq]),
    ).toEqual([
      ['turnAdvanced', 2],
      ['turnAdvanced', 3],
      ['resume.ok', 3],
    ])
  })

  it('un snapshot tambien recibe los eventos ocurridos durante la ventana, despues de el', async () => {
    const { connect, repo, gateway, gated } = await setup()
    const socket = await connect('a1')

    socket.emit({ type: 'resume', roomId: ROOM_ID })
    await gated.read
    await advance(repo, gateway, 'a1', 'c-1') // seq 2 dentro de la ventana
    gated.open()
    await flush()

    expect(
      socket
        .messages()
        .slice(1)
        .map((message) => [message.type, message.seq]),
    ).toEqual([
      ['snapshot', 1],
      ['turnAdvanced', 2],
      ['resume.ok', 2],
    ])
  })

  it('un hueco en lo retenido no se rellena: se detiene y resume.ok informa el ultimo seq REAL entregado', async () => {
    const { connect, repo, gateway, gated } = await setup()

    await advance(repo, gateway, 'a1', 'c-1') // seq 2
    await advance(repo, gateway, 'b1', 'c-2') // seq 3
    await advance(repo, gateway, 'a1', 'c-3') // seq 4

    const socket = await connect('b1')

    socket.emit({ type: 'resume', roomId: ROOM_ID, lastSeq: 3 })
    await gated.read

    // Llega el seq 6 sin haber visto el 5 (no ocurre con un unico proceso; el
    // cliente lo detecta por `seq` y pide otro resume): NO se entrega como si nada.
    const room = await repo.findById(ROOM_ID)
    const [event] = room?.eventsAfter(3) ?? []

    if (event === undefined) {
      throw new Error('se esperaba un evento')
    }
    gateway.publish(ROOM_ID, [{ ...event, seq: 6 }])
    gated.open()
    await flush()

    const received = socket.messages().slice(1)

    expect(received.map((message) => message.seq)).toEqual([4, 4])
    expect(received.at(-1)).toEqual({ type: 'resume.ok', roomId: ROOM_ID, seq: 4 })
  })

  it('un NO participante nunca recibe lo retenido: command.rejected y nada mas, tampoco despues', async () => {
    const { connect, repo, gateway, gated } = await setup()
    const intruso = await connect('intruso')

    intruso.emit({ type: 'resume', roomId: ROOM_ID })
    await flush() // el caso de uso lanza RoomAccessForbiddenError antes de la compuerta

    await advance(repo, gateway, 'a1', 'c-1')
    gated.open()
    await flush()
    await advance(repo, gateway, 'b1', 'c-2')

    expect(intruso.messages().map((message) => message.type)).toEqual([
      'auth.ok',
      'command.rejected',
    ])
  })

  it('dos resume seguidos de la misma conexion se serializan: no comparten ventana y terminan en orden', async () => {
    const { connect, repo, gateway, gated } = await setup()
    const socket = await connect('a1')

    socket.emit({ type: 'resume', roomId: ROOM_ID })
    socket.emit({ type: 'resume', roomId: ROOM_ID, lastSeq: 1 })
    await gated.read
    await advance(repo, gateway, 'a1', 'c-1')
    gated.open()
    await flush()

    const types = socket
      .messages()
      .slice(1)
      .map((message) => message.type)

    expect(types.filter((type) => type === 'resume.ok')).toHaveLength(2)
    expect(socket.messages().slice(1).at(-1)).toMatchObject({ type: 'resume.ok', seq: 2 })
  })

  it('un resume que falla libera la ventana: no queda reteniendo eventos ni suscrito', async () => {
    const { connect, repo, gateway } = await setup()
    const intruso = await connect('intruso')

    intruso.emit({ type: 'resume', roomId: ROOM_ID })
    await flush()
    intruso.sent.length = 0

    await advance(repo, gateway, 'a1', 'c-1')

    expect(intruso.sent).toEqual([])
  })
})

describe('BattleRoomRealtimeGateway — latido (ADR-020)', () => {
  it('envia un ping cada 25 s y una conexion que responde sigue abierta', async () => {
    jest.useFakeTimers()
    const { connect } = world()
    const socket = await connect('a1')

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    socket.pong()
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)

    expect(socket.pings).toBe(2)
    expect(socket.terminated).toBe(false)
    expect(HEARTBEAT_INTERVAL_MS).toBe(25_000)
  })

  it('una conexion que no responde al ping se corta en el siguiente latido', async () => {
    jest.useFakeTimers()
    const { connect } = world()
    const socket = await connect('a1')

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)

    expect(socket.pings).toBe(1)
    expect(socket.terminated).toBe(true)
  })

  it('cerrar la conexion detiene su latido', async () => {
    jest.useFakeTimers()
    const { connect } = world()
    const socket = await connect('a1')

    socket.close()
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 4)

    expect(socket.pings).toBe(0)
  })
})
