import { toBattleEventWire } from '../../src/application/dto/BattleEventDto'
import type { BattleEvent } from '../../src/domain/entities/BattleEvent'
import { BattleEventType } from '../../src/domain/entities/BattleEvent'
import { NOW, ROOM_ID } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'

/**
 * Forma EXACTA en el cable de los mensajes de HU-21 (contrato §6.1 y §6.2):
 * las mismas claves para todos los clientes y ninguna de mas. El evento
 * persistido y el difundido son el mismo objeto, asi que este es el unico
 * traductor y aqui se fija su contrato.
 */
const room = battleWithCombat()
const view = room.battleView()

if (view === null) {
  throw new Error('La sala de prueba necesita vista de batalla.')
}

const timedOut: BattleEvent = {
  seq: 5,
  type: BattleEventType.TurnTimedOut,
  occurredAt: NOW,
  payload: {
    completedPosition: 0,
    timedOut: { teamLabel: 'A', seat: 0 },
    battle: view,
  },
}

const finished: BattleEvent = {
  seq: 6,
  type: BattleEventType.BattleFinished,
  occurredAt: NOW,
  payload: {
    result: {
      reason: 'ELIMINATION',
      outcome: 'WIN',
      winnerTeamLabel: 'A',
      finishedAt: NOW.toISOString(),
      tiebreak: null,
      disconnected: null,
      teams: [
        { teamLabel: 'A', remainingHealth: 44, maxHealth: 44, lifePercent: 100, eliminated: false },
        { teamLabel: 'B', remainingHealth: 0, maxHealth: 44, lifePercent: 0, eliminated: true },
      ],
      participants: [
        {
          teamLabel: 'A',
          seat: 0,
          kind: 'HUMAN',
          playerId: 'a1',
          displayName: 'Nombre a1',
          heroId: 'hero-a1',
          result: 'WON',
        },
        {
          teamLabel: 'B',
          seat: 0,
          kind: 'HUMAN',
          playerId: 'b1',
          displayName: 'Nombre b1',
          heroId: 'hero-b1',
          result: 'LOST',
        },
      ],
    },
    battle: view,
  },
}

/** Excepcion de curacion de HU-12 (Tabla 7, sin Task de Management): Reanimacion. */
const healed: BattleEvent = {
  seq: 7,
  type: BattleEventType.HealSkillUsed,
  occurredAt: NOW,
  payload: {
    commandId: 'cmd-heal',
    completedPosition: 0,
    actor: { teamLabel: 'A', seat: 0 },
    target: { teamLabel: 'A', seat: 1 },
    skill: {
      abilityId: 'reanimacion-id',
      name: 'Reanimacion',
      powerCost: { mode: 'ALL_AVAILABLE' },
      chargeTurns: 1,
    },
    power: { before: 10, after: 0 },
    cooldown: { remainingTurns: 1 },
    heal: { amount: 32 },
    targetHealth: { before: 12, after: 44 },
    battle: view,
  },
}

describe('toBattleEventWire — HU-21 (contrato §6)', () => {
  it('`turnTimedOut` lleva exactamente type, seq, roomId, occurredAt, completedPosition, timedOut y battle', () => {
    const wire = toBattleEventWire(ROOM_ID, timedOut)

    expect(wire).toEqual({
      type: 'turnTimedOut',
      seq: 5,
      roomId: ROOM_ID,
      occurredAt: NOW.toISOString(),
      completedPosition: 0,
      timedOut: { teamLabel: 'A', seat: 0 },
      battle: view,
    })
    expect(Object.keys(wire).sort()).toEqual([
      'battle',
      'completedPosition',
      'occurredAt',
      'roomId',
      'seq',
      'timedOut',
      'type',
    ])
  })

  it('`battleFinished` lleva exactamente type, seq, roomId, occurredAt, result y battle', () => {
    const wire = toBattleEventWire(ROOM_ID, finished)

    expect(wire).toEqual({
      type: 'battleFinished',
      seq: 6,
      roomId: ROOM_ID,
      occurredAt: NOW.toISOString(),
      result: (finished.payload as { result: unknown }).result,
      battle: view,
    })
    expect(Object.keys(wire).sort()).toEqual([
      'battle',
      'occurredAt',
      'result',
      'roomId',
      'seq',
      'type',
    ])
  })

  it('`healSkillUsed` (excepcion de curacion, HU-12): SIN resolution ni bonus, con heal y targetHealth', () => {
    const wire = toBattleEventWire(ROOM_ID, healed)

    expect(wire).toEqual({
      type: 'healSkillUsed',
      seq: 7,
      roomId: ROOM_ID,
      occurredAt: NOW.toISOString(),
      commandId: 'cmd-heal',
      completedPosition: 0,
      actor: { teamLabel: 'A', seat: 0 },
      target: { teamLabel: 'A', seat: 1 },
      skill: {
        abilityId: 'reanimacion-id',
        name: 'Reanimacion',
        powerCost: { mode: 'ALL_AVAILABLE' },
        chargeTurns: 1,
      },
      power: { before: 10, after: 0 },
      cooldown: { remainingTurns: 1 },
      heal: { amount: 32 },
      targetHealth: { before: 12, after: 44 },
      battle: view,
    })
    expect(Object.keys(wire).sort()).toEqual([
      'actor',
      'battle',
      'commandId',
      'completedPosition',
      'cooldown',
      'heal',
      'occurredAt',
      'power',
      'roomId',
      'seq',
      'skill',
      'target',
      'targetHealth',
      'type',
    ])
  })

  it('los mensajes anteriores NO cambian de forma (control)', () => {
    const startedEvent = room.events[0]

    if (startedEvent === undefined) {
      throw new Error('la sala de prueba necesita su primer evento')
    }

    const started = toBattleEventWire(ROOM_ID, startedEvent)

    expect(Object.keys(started).sort()).toEqual(['battle', 'occurredAt', 'roomId', 'seq', 'type'])
    expect(started.type).toBe('battleStarted')
  })
})
