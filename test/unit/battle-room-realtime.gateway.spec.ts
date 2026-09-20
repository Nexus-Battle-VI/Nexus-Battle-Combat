import 'reflect-metadata'

import { BattleRoomRealtimeGateway } from '../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import {
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { CreateBattleRoom } from '../../src/application/use-cases/CreateBattleRoom'
import type { Logger } from '../../src/infrastructure/observability/logger'

/**
 * Gateway WebSocket de HU-15.2 (RF-15, ADR-020, vertical minimo -- ver el
 * comentario de cabecera de `BattleRoomRealtimeGateway.ts`).
 *
 * Se ejercita con un socket FALSO (`FakeSocket`), no una conexion WebSocket
 * real: el gateway se disena para que su logica de autenticacion,
 * suscripcion y difusion sea independiente del transporte concreto (`ws`),
 * igual que el resto del proyecto prueba HTTP con `supertest` contra la app
 * completa PERO la logica interna con dobles. Cubre exactamente lo que pide
 * la tarea: conexion autenticada, rechazo no autenticado, suscripcion
 * valida, aislamiento entre salas, evento tras join (simulado invocando
 * `notifyRoomUpdated` como lo haria el controlador), desconexion limpia y
 * forma del payload.
 */
const NOW = new Date('2026-09-19T12:00:00.000Z')
const clock: ClockPort = { now: () => NOW }
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const VALID_TOKEN = 'token-valido'
const IDENTITY: VerifiedIdentity = { subject: 'sujeto-1', email: null, roles: new Set() }

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> =>
    token === VALID_TOKEN
      ? Promise.resolve(IDENTITY)
      : Promise.reject(new TokenVerificationError()),
}

type MessageListener = (data: { toString(): string }) => void
type CloseListener = () => void

class FakeSocket {
  readyState = 1
  readonly sent: string[] = []
  readonly closeCalls: { code?: number; reason?: string }[] = []
  private messageListener: MessageListener | null = null
  private closeListener: CloseListener | null = null

  on(event: 'message' | 'close', listener: MessageListener | CloseListener): void {
    if (event === 'message') {
      this.messageListener = listener
    } else {
      this.closeListener = listener as CloseListener
    }
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.closeCalls.push({ code, reason })
    this.closeListener?.()
  }

  /** Simula al cliente enviando un mensaje JSON. */
  emitMessage(payload: unknown): void {
    this.messageListener?.({ toString: () => JSON.stringify(payload) })
  }

  lastSent(): Record<string, unknown> {
    const last = this.sent[this.sent.length - 1]
    if (last === undefined) throw new Error('el socket no envio ningun mensaje')
    return JSON.parse(last) as Record<string, unknown>
  }
}

const buildRoom = async (
  repo: InMemoryBattleRoomRepository,
  roomId = '00000000-0000-4000-8000-000000000001',
) => {
  const ids: IdGeneratorPort = { generate: () => roomId }
  const create = new CreateBattleRoom(repo, ids, clock)
  return create.execute('creador', {
    mode: 'PVP',
    teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
    reward: { amount: 0 },
  })
}

describe('BattleRoomRealtimeGateway (HU-15.2, ADR-020, vertical minimo)', () => {
  it('rechaza una conexion que no se autentica en la ventana concedida (simulada disparando el timer manualmente no es posible aqui; se verifica el cierre explicito por token invalido)', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const gateway = new BattleRoomRealtimeGateway(stubVerifier, repo, silentLogger)
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emitMessage({ type: 'auth', token: 'token-invalido' })
    // Espera a que se resuelva la promesa de verificacion (microtask).
    await Promise.resolve()
    await Promise.resolve()

    expect(socket.closeCalls).toHaveLength(1)
    expect(socket.closeCalls[0]?.code).toBe(4401)
  })

  it('conexion autenticada: token valido responde auth.ok y no cierra el socket', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const gateway = new BattleRoomRealtimeGateway(stubVerifier, repo, silentLogger)
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emitMessage({ type: 'auth', token: VALID_TOKEN })
    await Promise.resolve()
    await Promise.resolve()

    expect(socket.closeCalls).toHaveLength(0)
    expect(socket.lastSent()).toEqual({ type: 'auth.ok' })
  })

  it('suscripcion sin autenticar primero -> rechazada (4401)', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const gateway = new BattleRoomRealtimeGateway(stubVerifier, repo, silentLogger)
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emitMessage({ type: 'subscribe', roomId: 'cualquiera' })
    await Promise.resolve()

    expect(socket.closeCalls[0]?.code).toBe(4401)
  })

  it('suscripcion valida: sala existente tras autenticarse responde subscribe.ok', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const created = await buildRoom(repo)
    const gateway = new BattleRoomRealtimeGateway(stubVerifier, repo, silentLogger)
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emitMessage({ type: 'auth', token: VALID_TOKEN })
    await Promise.resolve()
    await Promise.resolve()
    socket.emitMessage({ type: 'subscribe', roomId: created.id })
    await Promise.resolve()
    await Promise.resolve()

    expect(socket.lastSent()).toEqual({
      type: 'subscribe.ok',
      roomId: created.id,
    })
  })

  it('suscripcion a una sala inexistente se rechaza (el servidor autoriza, no acepta cualquier roomId)', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const gateway = new BattleRoomRealtimeGateway(stubVerifier, repo, silentLogger)
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emitMessage({ type: 'auth', token: VALID_TOKEN })
    await Promise.resolve()
    await Promise.resolve()
    socket.emitMessage({ type: 'subscribe', roomId: 'sala-que-no-existe' })
    await Promise.resolve()
    await Promise.resolve()

    expect(socket.closeCalls).toHaveLength(1)
  })

  it('aislamiento entre salas: un cliente suscrito a la sala A no recibe eventos de la sala B', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const roomA = await buildRoom(repo, '00000000-0000-4000-8000-0000000000aa')
    const roomB = await buildRoom(repo, '00000000-0000-4000-8000-0000000000bb')
    const gateway = new BattleRoomRealtimeGateway(stubVerifier, repo, silentLogger)

    const socketA = new FakeSocket()
    gateway.handleConnection(socketA)
    socketA.emitMessage({ type: 'auth', token: VALID_TOKEN })
    await Promise.resolve()
    await Promise.resolve()
    socketA.emitMessage({ type: 'subscribe', roomId: roomA.id })
    await Promise.resolve()
    await Promise.resolve()

    const socketB = new FakeSocket()
    gateway.handleConnection(socketB)
    socketB.emitMessage({ type: 'auth', token: VALID_TOKEN })
    await Promise.resolve()
    await Promise.resolve()
    socketB.emitMessage({ type: 'subscribe', roomId: roomB.id })
    await Promise.resolve()
    await Promise.resolve()

    gateway.notifyRoomUpdated({ roomId: roomB.id, status: 'PREPARING', version: 2 })

    const eventsOnA = socketA.sent.filter(
      (raw) => (JSON.parse(raw) as { type: string }).type === 'battle-room.updated',
    )
    const eventsOnB = socketB.sent.filter(
      (raw) => (JSON.parse(raw) as { type: string }).type === 'battle-room.updated',
    )

    expect(eventsOnA).toHaveLength(0)
    expect(eventsOnB).toHaveLength(1)
  })

  it('forma del payload: roomId, status, version -- nada mas', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const created = await buildRoom(repo)
    const gateway = new BattleRoomRealtimeGateway(stubVerifier, repo, silentLogger)
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emitMessage({ type: 'auth', token: VALID_TOKEN })
    await Promise.resolve()
    await Promise.resolve()
    socket.emitMessage({ type: 'subscribe', roomId: created.id })
    await Promise.resolve()
    await Promise.resolve()

    gateway.notifyRoomUpdated({ roomId: created.id, status: 'WAITING_FOR_PLAYERS', version: 1 })

    const event = socket.lastSent()
    expect(event).toEqual({
      type: 'battle-room.updated',
      roomId: created.id,
      status: 'WAITING_FOR_PLAYERS',
      version: 1,
    })
    expect(Object.keys(event).sort()).toEqual(['roomId', 'status', 'type', 'version'])
  })

  it('desconexion limpia: tras cerrar, notifyRoomUpdated ya no envia nada a ese socket', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const created = await buildRoom(repo)
    const gateway = new BattleRoomRealtimeGateway(stubVerifier, repo, silentLogger)
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emitMessage({ type: 'auth', token: VALID_TOKEN })
    await Promise.resolve()
    await Promise.resolve()
    socket.emitMessage({ type: 'subscribe', roomId: created.id })
    await Promise.resolve()
    await Promise.resolve()

    socket.close()
    socket.sent.length = 0

    gateway.notifyRoomUpdated({ roomId: created.id, status: 'PREPARING', version: 2 })

    expect(socket.sent).toHaveLength(0)
  })

  it('evento tras join simulado: el controlador dispara notifyRoomUpdated con el resultado ya persistido', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const created = await buildRoom(repo)
    const gateway = new BattleRoomRealtimeGateway(stubVerifier, repo, silentLogger)
    const socket = new FakeSocket()

    gateway.handleConnection(socket)
    socket.emitMessage({ type: 'auth', token: VALID_TOKEN })
    await Promise.resolve()
    await Promise.resolve()
    socket.emitMessage({ type: 'subscribe', roomId: created.id })
    await Promise.resolve()
    await Promise.resolve()

    // Mismo criterio que `battle-room.controller.ts::notifyRoomUpdated`:
    // se invoca DESPUES de persistir, con el DTO ya devuelto por el caso de uso.
    gateway.notifyRoomUpdated({ roomId: created.id, status: 'PREPARING', version: 2 })

    expect(socket.lastSent()).toMatchObject({
      type: 'battle-room.updated',
      status: 'PREPARING',
    })
  })
})
