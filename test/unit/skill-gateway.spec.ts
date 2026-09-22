import 'reflect-metadata'

import { BasicAttackRealtimeHandler } from '../../src/adapters/inbound/ws/BasicAttackRealtimeHandler'
import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { SkillRealtimeHandler } from '../../src/adapters/inbound/ws/SkillRealtimeHandler'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryRealtimeTicketStore } from '../../src/adapters/outbound/realtime/InMemoryRealtimeTicketStore'
import type { RealtimeTicketCodecPort } from '../../src/application/ports/RealtimeTicketPort'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import {
  ConsumeRealtimeTicket,
  IssueRealtimeTicket,
} from '../../src/application/use-cases/RealtimeTickets'
import { ResumeBattle } from '../../src/application/use-cases/ResumeBattle'
import { UseSkill } from '../../src/application/use-cases/UseSkill'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { ROOM_ID, clock, scriptedSequence, silentLogger } from '../fixtures/battle'
import { indexForEffect, indexForFace } from '../fixtures/basic-attack'
import { FakeSocket, flush } from '../fixtures/fake-socket'
import { buildGateway } from '../fixtures/gateway'
import { SHIELD_STRIKE_ID, STONE_HAND_ID, battleWithSkills, skillProfile } from '../fixtures/skills'

/**
 * `useSkill` (HU-19) a traves del GATEWAY REAL, con los casos de uso y los handlers reales, la
 * sala en memoria y la secuencia HU-24 guionizada; solo el socket es falso. Cubre lo que solo el
 * gateway decide: autenticacion previa, difusion a los participantes que hicieron `resume`,
 * respuestas solo al remitente y el orden por conexion entre `attack` y `useSkill`.
 */
const codec: RealtimeTicketCodecPort = {
  generate: (() => {
    let counter = 0

    return () => `ticket-${String((counter += 1))}`
  })(),
  hash: (ticket) => `h:${ticket}`,
}

const attackDie = (face: number): number => indexForFace(face, 6)
const DAMAGE = indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage)
const damageDie = (face: number): number => indexForFace(face, 6)
/** Golpe con escudo: dado de Ataque 5 (10 + 2 + 5 = 17), causar dano, dado de Dano 4. */
const SKILL_HIT = [attackDie(5), DAMAGE, damageDie(4)]

const world = async (
  indices: readonly number[] = SKILL_HIT,
  profiles: Record<string, ReturnType<typeof skillProfile>> = {},
) => {
  const repo = new InMemoryBattleRoomRepository()
  const store = new InMemoryRealtimeTicketStore()
  const issue = new IssueRealtimeTicket(codec, store, clock)
  const sequence = scriptedSequence(indices)
  const lock = new ChannelLock()
  const attack = new ExecuteBasicAttack(repo, clock, sequence, lock)
  const skill = new UseSkill(repo, clock, sequence, lock, attack)
  const gateway = buildGateway({
    consumeTicket: new ConsumeRealtimeTicket(codec, store, clock),
    rooms: repo,
    resumeBattle: new ResumeBattle(repo),
    attack: new BasicAttackRealtimeHandler(attack, silentLogger),
    skill: new SkillRealtimeHandler(skill, silentLogger),
  })

  await repo.save(
    battleWithSkills({ profiles: { a1: skillProfile(), b1: skillProfile(), ...profiles } }),
    0,
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

const SKILL = {
  type: 'useSkill',
  commandId: 'cmd-1',
  roomId: ROOM_ID,
  abilityId: SHIELD_STRIKE_ID,
  target: { teamLabel: 'B', seat: 0 },
}

const messages = (socket: FakeSocket): Record<string, unknown>[] =>
  socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)

interface CombatantJson {
  teamLabel: string
  power: { current: number; max: number } | null
  skills: { abilityId: string; cooldownRemaining: number; status: string }[]
}

const combatantsOf = (event: Record<string, unknown>): CombatantJson[] =>
  (event.battle as { combatants: CombatantJson[] }).combatants

describe('Gateway — comando useSkill (HU-19)', () => {
  it('sin autenticar cierra con 4401, como attack, subscribe y resume', async () => {
    const { connect, sequence } = await world()
    const socket = await connect(null)

    socket.emit(SKILL)
    await flush()

    expect(socket.closeCalls[0]?.code).toBe(4401)
    expect(sequence.consumed()).toBe(0)
  })

  it('la habilidad se difunde a AMBOS participantes con los MISMOS bytes', async () => {
    const { join } = await world()
    const a = await join('a1')
    const b = await join('b1')

    a.emit(SKILL)
    await flush()

    expect(a.sent).toHaveLength(1)
    expect(b.sent).toEqual(a.sent)

    const [event] = messages(a)

    expect(event).toMatchObject({
      type: 'skillUsed',
      seq: 2,
      roomId: ROOM_ID,
      commandId: 'cmd-1',
      actor: { teamLabel: 'A', seat: 0 },
      target: { teamLabel: 'B', seat: 0 },
      skill: { abilityId: SHIELD_STRIKE_ID, name: 'Golpe con escudo' },
      power: { before: 10, after: 8 },
      cooldown: { remainingTurns: 1 },
      bonus: { attack: 2, damage: 0 },
      targetHealth: { before: 44, after: 40 },
    })
    expect((event?.battle as { turnsCompleted: number }).turnsCompleted).toBe(1)
  })

  it('la vista lleva el Poder y las habilidades de cada participante, con la recarga marcada', async () => {
    const { join } = await world()
    const a = await join('a1')

    a.emit(SKILL)
    await flush()

    const [event] = messages(a)
    const [first, second] = combatantsOf(event!)

    expect(first).toMatchObject({ teamLabel: 'A', power: { current: 8, max: 10 } })
    expect(first?.skills[0]).toMatchObject({
      abilityId: SHIELD_STRIKE_ID,
      cooldownRemaining: 1,
      status: 'RECHARGING',
    })
    expect(first?.skills.find((skill) => skill.abilityId === STONE_HAND_ID)?.status).toBe(
      'UNSUPPORTED',
    )
    expect(second).toMatchObject({ teamLabel: 'B', power: { current: 10, max: 10 } })
  })

  it('ningun mensaje de la habilidad contiene semilla, indices, estadisticas ni los EFECTOS de la habilidad', async () => {
    const { join } = await world()
    const a = await join('a1')

    a.emit(SKILL)
    await flush()

    const event = messages(a)[0]!

    expect(Object.keys(event).sort()).toEqual([
      'actor',
      'battle',
      'bonus',
      'commandId',
      'completedPosition',
      'cooldown',
      'occurredAt',
      'power',
      'resolution',
      'roomId',
      'seq',
      'skill',
      'target',
      'targetHealth',
      'type',
    ])
    expect(Object.keys(event.skill as Record<string, unknown>).sort()).toEqual([
      'abilityId',
      'chargeTurns',
      'name',
      'powerCost',
    ])
    for (const combatant of combatantsOf(event)) {
      expect(Object.keys(combatant).sort()).toEqual([
        'health',
        'power',
        'seat',
        'skills',
        'teamLabel',
      ])
      for (const skill of combatant.skills) {
        expect(Object.keys(skill).sort()).toEqual([
          'abilityId',
          'chargeTurns',
          'cooldownRemaining',
          'name',
          'powerCost',
          'status',
        ])
      }
    }
    expect(a.sent[0]).not.toMatch(
      /seed|semilla|activeEffects|effects|statistic|operation|magnitude|durationTurns|hasActivationCondition|token|ticket|maxHealth/i,
    )
  })

  it('un rechazo responde SOLO al remitente y no difunde nada (habilidad de otra clase)', async () => {
    const { join, sequence } = await world([], {
      a1: skillProfile({ abilities: [] }),
    })
    const a = await join('a1')
    const b = await join('b1')

    a.emit(SKILL)
    await flush()

    expect(messages(a)).toEqual([
      { type: 'command.rejected', command: 'useSkill', commandId: 'cmd-1', code: 'UNKNOWN_SKILL' },
    ])
    expect(b.sent).toEqual([])
    expect(sequence.consumed()).toBe(0)
  })

  it('una habilidad con un efecto no soportado se rechaza con UNSUPPORTED_SKILL_EFFECT sin exponer el motivo', async () => {
    const { join } = await world()
    const a = await join('a1')

    a.emit({ ...SKILL, abilityId: STONE_HAND_ID })
    await flush()

    expect(messages(a)).toEqual([
      {
        type: 'command.rejected',
        command: 'useSkill',
        commandId: 'cmd-1',
        code: 'UNSUPPORTED_SKILL_EFFECT',
      },
    ])
  })

  it('el Poder insuficiente NO se rechaza: llega un basicAttackResolved con degradedFrom a AMBOS', async () => {
    const { join } = await world(SKILL_HIT, { a1: skillProfile({ maxPower: 1 }) })
    const a = await join('a1')
    const b = await join('b1')

    a.emit(SKILL)
    await flush()

    expect(b.sent).toEqual(a.sent)
    expect(messages(a)[0]).toMatchObject({
      type: 'basicAttackResolved',
      degradedFrom: {
        command: 'useSkill',
        abilityId: SHIELD_STRIKE_ID,
        reason: 'INSUFFICIENT_POWER',
      },
      // Sin el bono de la habilidad: 10 + 5.
      resolution: { attackValue: 15 },
    })
    expect(combatantsOf(messages(a)[0]!)[0]?.power).toEqual({ current: 1, max: 1 })
  })

  it('un mensaje mal formado (una clave de mas) se rechaza sin llegar al caso de uso', async () => {
    const { join, sequence } = await world()
    const a = await join('a1')

    a.emit({ ...SKILL, power: 99 })
    await flush()

    expect(messages(a)).toEqual([
      {
        type: 'command.rejected',
        command: 'useSkill',
        commandId: 'cmd-1',
        code: 'MALFORMED_COMMAND',
      },
    ])
    expect(sequence.consumed()).toBe(0)
  })

  it('el commandId repetido se reenvia SOLO al remitente y no vuelve a sortear ni a cobrar Poder', async () => {
    const { join, sequence } = await world()
    const a = await join('a1')
    const b = await join('b1')

    a.emit(SKILL)
    await flush()
    const original = a.sent[0]

    a.sent.length = 0
    b.sent.length = 0
    a.emit(SKILL)
    await flush()

    expect(a.sent).toEqual([original])
    expect(b.sent).toEqual([])
    expect(sequence.consumed()).toBe(3)
  })

  it('un attack y un useSkill seguidos de una conexion se atienden en orden: el segundo ve el turno ya avanzado', async () => {
    const { join, sequence } = await world([...SKILL_HIT, ...SKILL_HIT])
    const a = await join('a1')

    a.emit({ ...SKILL, commandId: 'skill-1' })
    a.emit({
      type: 'attack',
      commandId: 'attack-1',
      roomId: ROOM_ID,
      target: { teamLabel: 'B', seat: 0 },
    })
    await flush()

    const sent = messages(a)

    expect(sent[0]).toMatchObject({ type: 'skillUsed', commandId: 'skill-1' })
    // El ataque llega despues, con el turno ya en b1: NOT_YOUR_TURN, sin sorteos.
    expect(sent[1]).toMatchObject({
      type: 'command.rejected',
      command: 'attack',
      code: 'NOT_YOUR_TURN',
    })
    expect(sequence.consumed()).toBe(3)
  })

  it('un no participante y un suscrito solo al lobby NO reciben la habilidad', async () => {
    const { join, connect } = await world()
    const a = await join('a1')
    const outsider = await connect('intruso')
    const lobby = await connect('b1')

    lobby.emit({ type: 'subscribe', roomId: ROOM_ID })
    await flush()
    lobby.sent.length = 0
    outsider.sent.length = 0
    a.emit(SKILL)
    await flush()

    expect(outsider.sent).toEqual([])
    expect(lobby.sent).toEqual([])
  })

  it('un snapshot (recarga sin lastSeq) trae el Poder y la recarga actuales', async () => {
    const { join, connect } = await world()
    const a = await join('a1')

    a.emit(SKILL)
    await flush()
    const refreshed = await connect('b1')

    refreshed.emit({ type: 'resume', roomId: ROOM_ID })
    await flush()

    const snapshot = messages(refreshed).find((message) => message.type === 'snapshot')!
    const [first] = combatantsOf(snapshot)

    expect(first).toMatchObject({ teamLabel: 'A', power: { current: 8, max: 10 } })
    expect(first?.skills[0]).toMatchObject({ cooldownRemaining: 1, status: 'RECHARGING' })
  })

  it('un resume con lastSeq reenvia el skillUsed persistido con los mismos bytes que se difundieron', async () => {
    const { join, connect } = await world()
    const a = await join('a1')

    a.emit(SKILL)
    await flush()
    const original = a.sent[0]
    const late = await connect('b1')

    late.emit({ type: 'resume', roomId: ROOM_ID, lastSeq: 1 })
    await flush()

    expect(late.sent).toContain(original)
  })
})
