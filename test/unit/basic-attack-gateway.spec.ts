import 'reflect-metadata'

import { BasicAttackRealtimeHandler } from '../../src/adapters/inbound/ws/BasicAttackRealtimeHandler'
import { BattleRoomRealtimeGateway } from '../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import type { ChatRealtimeHandler } from '../../src/adapters/inbound/ws/ChatRealtimeHandler'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryRealtimeTicketStore } from '../../src/adapters/outbound/realtime/InMemoryRealtimeTicketStore'
import type { RealtimeTicketCodecPort } from '../../src/application/ports/RealtimeTicketPort'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import {
  ConsumeRealtimeTicket,
  IssueRealtimeTicket,
} from '../../src/application/use-cases/RealtimeTickets'
import { ResumeBattle } from '../../src/application/use-cases/ResumeBattle'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { ROOM_ID, clock, scriptedSequence, silentLogger } from '../fixtures/battle'
import { battleWithCombat, indexForEffect, indexForFace } from '../fixtures/basic-attack'
import { FakeSocket, flush } from '../fixtures/fake-socket'

/**
 * `attack` (HU-18) a traves del GATEWAY REAL, con el caso de uso y el handler reales,
 * la sala en memoria y la secuencia HU-24 guionizada; solo el socket es falso. Cubre lo
 * que solo el gateway decide: autenticacion previa, difusion a los participantes que
 * hicieron `resume`, respuestas solo al remitente y el orden por conexion.
 */
const codec: RealtimeTicketCodecPort = {
  generate: (() => {
    let counter = 0

    return () => `ticket-${String((counter += 1))}`
  })(),
  hash: (ticket) => `h:${ticket}`,
}

const noChat = {
  handle: jest.fn(),
  onDisconnect: jest.fn(),
  onRoomUpdated: jest.fn(),
} as unknown as ChatRealtimeHandler

const ATTACK_DIE = indexForFace(5, 6)
const DAMAGE = indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage)
const DAMAGE_DIE = indexForFace(4, 6)
const HIT = [ATTACK_DIE, DAMAGE, DAMAGE_DIE]

const world = async (indices: readonly number[] = HIT) => {
  const repo = new InMemoryBattleRoomRepository()
  const store = new InMemoryRealtimeTicketStore()
  const issue = new IssueRealtimeTicket(codec, store, clock)
  const sequence = scriptedSequence(indices)
  const attack = new ExecuteBasicAttack(repo, clock, sequence, new ChannelLock())
  const gateway = new BattleRoomRealtimeGateway(
    new ConsumeRealtimeTicket(codec, store, clock),
    repo,
    new ResumeBattle(repo),
    silentLogger,
    noChat,
    new BasicAttackRealtimeHandler(attack, silentLogger),
  )

  await repo.save(battleWithCombat(), 0)

  const connect = async (subject: string | null): Promise<FakeSocket> => {
    const socket = new FakeSocket()

    gateway.handleConnection(socket)

    if (subject !== null) {
      socket.emit({ type: 'auth', ticket: issue.execute(subject).ticket })
      await flush()
    }

    return socket
  }

  /** Autentica y hace `resume`: solo asi se reciben los eventos de la batalla. */
  const join = async (subject: string): Promise<FakeSocket> => {
    const socket = await connect(subject)

    socket.emit({ type: 'resume', roomId: ROOM_ID })
    await flush()
    socket.sent.length = 0

    return socket
  }

  return { repo, gateway, sequence, connect, join }
}

const ATTACK = {
  type: 'attack',
  commandId: 'cmd-1',
  roomId: ROOM_ID,
  target: { teamLabel: 'B', seat: 0 },
}

const messages = (socket: FakeSocket): Record<string, unknown>[] =>
  socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)

describe('Gateway — comando attack (HU-18)', () => {
  it('sin autenticar cierra con 4401, como subscribe y resume', async () => {
    const { connect, sequence } = await world()
    const socket = await connect(null)

    socket.emit(ATTACK)
    await flush()

    expect(socket.closeCalls[0]?.code).toBe(4401)
    expect(sequence.consumed()).toBe(0)
  })

  it('el ataque se difunde a AMBOS participantes con los MISMOS bytes, misma Vida y mismo turno', async () => {
    const { join } = await world()
    const a = await join('a1')
    const b = await join('b1')

    a.emit(ATTACK)
    await flush()

    expect(a.sent).toHaveLength(1)
    expect(b.sent).toEqual(a.sent)

    const [event] = messages(a)

    expect(event).toMatchObject({
      type: 'basicAttackResolved',
      seq: 2,
      roomId: ROOM_ID,
      commandId: 'cmd-1',
      attacker: { teamLabel: 'A', seat: 0 },
      target: { teamLabel: 'B', seat: 0 },
      targetHealth: { before: 44, after: 40 },
    })
    expect(
      (event?.battle as { turnsCompleted: number; combatants: unknown[] }).turnsCompleted,
    ).toBe(1)
    expect((event?.battle as { combatants: unknown[] }).combatants).toEqual([
      { teamLabel: 'A', seat: 0, health: { current: 44, max: 44 } },
      { teamLabel: 'B', seat: 0, health: { current: 40, max: 44 } },
    ])
  })

  it('un no participante y un suscrito solo al lobby NO reciben el ataque', async () => {
    const { join, connect } = await world()
    const a = await join('a1')
    const intruso = await connect('intruso')
    const lobby = await connect('b1')

    lobby.emit({ type: 'subscribe', roomId: ROOM_ID })
    await flush()
    lobby.sent.length = 0
    intruso.sent.length = 0

    a.emit(ATTACK)
    await flush()

    expect(intruso.sent).toEqual([])
    expect(lobby.sent).toEqual([])
  })

  it('un comando rechazado responde SOLO al remitente y nadie mas recibe nada', async () => {
    const { join, sequence } = await world()
    const a = await join('a1')
    const b = await join('b1')

    b.emit({ ...ATTACK, target: { teamLabel: 'A', seat: 0 } }) // fuera de turno
    await flush()

    expect(messages(b)).toEqual([
      { type: 'command.rejected', command: 'attack', commandId: 'cmd-1', code: 'NOT_YOUR_TURN' },
    ])
    expect(a.sent).toEqual([])
    expect(sequence.consumed()).toBe(0)
  })

  it('un ajeno a la sala recibe NOT_A_PARTICIPANT y no muta nada', async () => {
    const { connect, sequence } = await world()
    const intruso = await connect('intruso')

    intruso.emit(ATTACK)
    await flush()

    expect(messages(intruso).at(-1)).toEqual({
      type: 'command.rejected',
      command: 'attack',
      commandId: 'cmd-1',
      code: 'NOT_A_PARTICIPANT',
    })
    expect(sequence.consumed()).toBe(0)
  })

  it('un mensaje con un dato de mas (attackValue) es MALFORMED_COMMAND y no se ejecuta', async () => {
    const { join, sequence } = await world()
    const a = await join('a1')

    a.emit({ ...ATTACK, attackValue: 99 })
    await flush()

    expect(messages(a)).toEqual([
      {
        type: 'command.rejected',
        command: 'attack',
        commandId: 'cmd-1',
        code: 'MALFORMED_COMMAND',
      },
    ])
    expect(sequence.consumed()).toBe(0)
  })

  it('repetir el commandId: la repeticion llega SOLO a quien la envia, sin sorteos ni difusion', async () => {
    const { join, sequence } = await world()
    const a = await join('a1')
    const b = await join('b1')

    a.emit(ATTACK)
    await flush()
    const original = a.sent[0]

    a.sent.length = 0
    b.sent.length = 0
    a.emit(ATTACK)
    await flush()

    expect(a.sent).toEqual([original])
    expect(b.sent).toEqual([])
    expect(sequence.consumed()).toBe(3)
  })

  it('dos comandos DISTINTOS seguidos desde dos pestanas: solo uno muta; el otro NOT_YOUR_TURN', async () => {
    const { join, sequence } = await world()
    const pestanaUno = await join('a1')
    const pestanaDos = await join('a1')

    pestanaUno.emit({ ...ATTACK, commandId: 'cmd-x' })
    pestanaDos.emit({ ...ATTACK, commandId: 'cmd-y' })
    await flush()
    await flush()

    const rejected = [...messages(pestanaUno), ...messages(pestanaDos)].filter(
      (message) => message.type === 'command.rejected',
    )

    expect(rejected).toEqual([
      expect.objectContaining({ code: 'NOT_YOUR_TURN', command: 'attack' }),
    ])
    expect(sequence.consumed()).toBe(3)
    expect(
      [...messages(pestanaUno), ...messages(pestanaDos)].filter(
        (message) => message.type === 'basicAttackResolved',
      ),
    ).toHaveLength(2) // el mismo evento, una vez por cada pestana suscrita
  })

  it('los comandos de una conexion se atienden EN ORDEN: el ataque de a1 y luego la respuesta de b1', async () => {
    const { join } = await world([...HIT, ...HIT])
    const a = await join('a1')
    const b = await join('b1')

    a.emit(ATTACK)
    b.emit({ ...ATTACK, commandId: 'cmd-2', target: { teamLabel: 'A', seat: 0 } })
    await flush()
    await flush()

    expect(
      messages(a)
        .filter((message) => message.type === 'basicAttackResolved')
        .map((message) => message.seq),
    ).toEqual([2, 3])
  })

  it('un ataque persistido llega tambien tras un resume posterior (replay exacto, sin recalcular)', async () => {
    const { join, connect, sequence } = await world()
    const a = await join('a1')

    a.emit(ATTACK)
    await flush()
    const live = a.sent[0]
    const late = await connect('b1')

    late.emit({ type: 'resume', roomId: ROOM_ID, lastSeq: 1 })
    await flush()

    expect(late.sent.map((raw) => JSON.parse(raw) as { type: string }).map((m) => m.type)).toEqual([
      'auth.ok',
      'basicAttackResolved',
      'resume.ok',
    ])
    expect(late.sent[1]).toBe(live)
    expect(sequence.consumed()).toBe(3)
  })

  it('un snapshot (recarga sin lastSeq) trae la Vida actual y el turno vigente', async () => {
    const { join, connect } = await world()
    const a = await join('a1')

    a.emit(ATTACK)
    await flush()
    const refreshed = await connect('b1')

    refreshed.emit({ type: 'resume', roomId: ROOM_ID })
    await flush()

    const snapshot = messages(refreshed).find((message) => message.type === 'snapshot')

    expect(snapshot).toMatchObject({ seq: 2, status: 'IN_BATTLE' })
    expect((snapshot?.battle as { currentTurn: { playerId: string } }).currentTurn.playerId).toBe(
      'b1',
    )
    expect((snapshot?.battle as { combatants: unknown[] }).combatants).toEqual([
      { teamLabel: 'A', seat: 0, health: { current: 44, max: 44 } },
      { teamLabel: 'B', seat: 0, health: { current: 40, max: 44 } },
    ])
  })

  it('ningun mensaje del ataque contiene semilla, indices, estadisticas, efectos ni Poder', async () => {
    const { join } = await world()
    const a = await join('a1')

    a.emit(ATTACK)
    await flush()

    const event = messages(a)[0]!
    const battle = event.battle as Record<string, unknown>

    // Solo lo que explica el golpe: ninguna clave interna.
    expect(Object.keys(event).sort()).toEqual([
      'attacker',
      'battle',
      'commandId',
      'completedPosition',
      'occurredAt',
      'resolution',
      'roomId',
      'seq',
      'target',
      'targetHealth',
      'type',
    ])
    expect(Object.keys(event.resolution as Record<string, unknown>).sort()).toEqual([
      'appliedDamage',
      'attackValue',
      'baseDamage',
      'calculatedDamage',
      'defenseValue',
      'effect',
      'effective',
      'percent',
    ])
    expect(Object.keys(battle).sort()).toEqual([
      'battleId',
      'combatants',
      'currentTurn',
      'round',
      'startedAt',
      'turnOrder',
      'turnsCompleted',
    ])
    expect(a.sent[0]).not.toMatch(/seed|semilla|activeEffects|power|poder|token|ticket|maxHealth/i)
  })
})
