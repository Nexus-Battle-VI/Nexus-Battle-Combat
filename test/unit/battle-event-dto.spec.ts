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
