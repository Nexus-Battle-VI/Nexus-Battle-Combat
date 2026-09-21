import {
  AttackRejectionCode,
  BASIC_ATTACK_COMMAND,
  BasicAttackRealtimeHandler,
  parseAttackCommand,
} from '../../src/adapters/inbound/ws/BasicAttackRealtimeHandler'
import { toBattleEventWire } from '../../src/application/dto/BattleEventDto'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../src/application/errors/ApplicationError'
import type {
  ExecuteBasicAttack,
  ExecuteBasicAttackResult,
} from '../../src/application/use-cases/ExecuteBasicAttack'
import type { BattleEvent } from '../../src/domain/entities/BattleEvent'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  InvalidCommandIdError,
  InvalidTargetError,
  NotYourTurnError,
  SameTeamTargetError,
  TargetUnavailableError,
  UnsupportedCombatProfileError,
} from '../../src/domain/errors/BattleErrors'
import { ROOM_ID, silentLogger } from '../fixtures/battle'
import { FakeSocket } from '../fixtures/fake-socket'

/**
 * Comando `attack` de HU-18 en el adaptador de WebSocket: forma estricta del mensaje,
 * traduccion de errores a `command.rejected` con codigos estables y difusion SOLO tras
 * persistir. La logica de combate NO se ejerce aqui (tiene su propia suite).
 */
const VALID = {
  type: 'attack',
  commandId: 'cmd-1',
  roomId: ROOM_ID,
  target: { teamLabel: 'B', seat: 0 },
}

const EVENT: BattleEvent = {
  seq: 2,
  type: 'basicAttackResolved',
  occurredAt: new Date('2026-09-21T10:00:00.000Z'),
  payload: {
    commandId: 'cmd-1',
    completedPosition: 0,
    attacker: { teamLabel: 'A', seat: 0 },
    target: { teamLabel: 'B', seat: 0 },
    resolution: {
      attackValue: 15,
      defenseValue: 11,
      effective: true,
      effect: 'DAMAGE',
      percent: 100,
      baseDamage: 4,
      calculatedDamage: 4,
      appliedDamage: 4,
    },
    targetHealth: { before: 44, after: 40 },
    battle: {
      battleId: ROOM_ID,
      startedAt: '2026-09-21T10:00:00.000Z',
      turnOrder: [],
      turnsCompleted: 1,
      round: 1,
      currentTurn: {
        position: 1,
        teamLabel: 'B',
        seat: 0,
        kind: 'HUMAN',
        playerId: 'b1',
        displayName: null,
        heroId: null,
        heroSubtype: null,
      },
      combatants: [],
    },
  },
}

const handlerWith = (execute: () => Promise<ExecuteBasicAttackResult>) => {
  const attack = { execute: jest.fn(execute) } as unknown as ExecuteBasicAttack
  const errors: Record<string, unknown>[] = []
  const logger = {
    ...silentLogger,
    error: (
      _message: string,
      context: Readonly<Record<string, string | number | boolean | null>> = {},
    ) => {
      errors.push(context)
    },
  }
  const publish = jest.fn()
  const socket = new FakeSocket()

  return {
    handler: new BasicAttackRealtimeHandler(attack, logger),
    attack: attack as unknown as { execute: jest.Mock },
    publish,
    socket,
    errors,
    send: (message: Record<string, unknown> = VALID) =>
      new BasicAttackRealtimeHandler(attack, logger).handle(socket, 'sub-a', message, publish),
    sent: () => socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>),
  }
}

describe('parseAttackCommand — la forma del mensaje es estricta', () => {
  it('acepta exactamente type, commandId, roomId y target { teamLabel, seat }', () => {
    expect(parseAttackCommand(VALID)).toEqual({
      commandId: 'cmd-1',
      roomId: ROOM_ID,
      target: { teamLabel: 'B', seat: 0 },
    })
  })

  it.each([
    ['attackValue', { attackValue: 99 }],
    ['damage', { damage: 99 }],
    ['percent', { percent: 180 }],
    ['healthAfter', { healthAfter: 0 }],
    ['attackerId', { attackerId: 'a1' }],
    ['currentTurn', { currentTurn: 1 }],
    ['targets', { targets: [{ teamLabel: 'B', seat: 0 }] }],
    ['area', { area: true }],
    ['seed', { seed: 1 }],
  ])('rechaza una clave de mas (%s): el servidor no la ignora en silencio', (_name, extra) => {
    expect(parseAttackCommand({ ...VALID, ...extra })).toBeNull()
  })

  it.each(['commandId', 'roomId', 'target'])('rechaza si falta %s', (key) => {
    const rest: Record<string, unknown> = { ...VALID }

    Reflect.deleteProperty(rest, key)

    expect(parseAttackCommand(rest)).toBeNull()
  })

  const withTarget = (target: unknown): Record<string, unknown> => ({ ...VALID, target })

  const MALFORMED: readonly (readonly [string, Record<string, unknown>])[] = [
    ['target como arreglo', withTarget([{ teamLabel: 'B', seat: 0 }])],
    ['target vacio', withTarget([])],
    [
      'dos objetivos',
      withTarget([
        { teamLabel: 'B', seat: 0 },
        { teamLabel: 'B', seat: 1 },
      ]),
    ],
    ['target nulo', withTarget(null)],
    ['target texto', withTarget('B#0')],
    ['target sin seat', withTarget({ teamLabel: 'B' })],
    ['target sin teamLabel', withTarget({ seat: 0 })],
    ['target con heroId', withTarget({ teamLabel: 'B', seat: 0, heroId: 'x' })],
    ['teamLabel vacio', withTarget({ teamLabel: '', seat: 0 })],
    ['teamLabel numerico', withTarget({ teamLabel: 7, seat: 0 })],
    ['seat negativo', withTarget({ teamLabel: 'B', seat: -1 })],
    ['seat decimal', withTarget({ teamLabel: 'B', seat: 1.5 })],
    ['seat texto', withTarget({ teamLabel: 'B', seat: '0' })],
    ['commandId numerico', { ...VALID, commandId: 42 }],
    ['roomId que no es UUID', { ...VALID, roomId: 'no-es-un-uuid' }],
    ['UUID que no es v4', { ...VALID, roomId: '11111111-1111-1111-8111-111111111111' }],
    ['roomId numerico', { ...VALID, roomId: 7 }],
  ]

  it.each(MALFORMED)('rechaza %s', (_label, message) => {
    expect(parseAttackCommand(message)).toBeNull()
  })

  it('un commandId cadena pero vacio o largo NO es mal formado: lo rechaza el dominio como INVALID_COMMAND_ID', () => {
    expect(parseAttackCommand({ ...VALID, commandId: '' })).not.toBeNull()
    expect(parseAttackCommand({ ...VALID, commandId: 'x'.repeat(500) })).not.toBeNull()
  })
})

describe('BasicAttackRealtimeHandler', () => {
  it('el nombre del comando es `attack` (ADR-020)', () => {
    expect(BASIC_ATTACK_COMMAND).toBe('attack')
  })

  it('un mensaje mal formado responde MALFORMED_COMMAND SOLO al remitente y no llega al caso de uso', async () => {
    const { send, attack, sent, publish } = handlerWith(() =>
      Promise.reject(new Error('no debe llamarse')),
    )

    await send({ ...VALID, damage: 99 })

    expect(attack.execute).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(sent()).toEqual([
      {
        type: 'command.rejected',
        command: 'attack',
        commandId: 'cmd-1',
        code: 'MALFORMED_COMMAND',
      },
    ])
  })

  it('un mal formado sin commandId de tipo cadena no lo inventa', async () => {
    const { send, sent } = handlerWith(() => Promise.reject(new Error('no debe llamarse')))

    await send({ type: 'attack', commandId: 42 })

    expect(sent()).toEqual([
      { type: 'command.rejected', command: 'attack', code: 'MALFORMED_COMMAND' },
    ])
  })

  it('el atacante es el `sub` de la conexion, nunca un dato del mensaje', async () => {
    const { send, attack } = handlerWith(() => Promise.resolve({ event: EVENT, replayed: false }))

    await send()

    expect(attack.execute).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      requesterId: 'sub-a',
      commandId: 'cmd-1',
      target: { teamLabel: 'B', seat: 0 },
    })
  })

  it('un ataque nuevo se DIFUNDE una vez con el evento persistido y el remitente no recibe un duplicado directo', async () => {
    const { send, publish, sent } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: false }),
    )

    await send()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(ROOM_ID, [EVENT])
    expect(sent()).toEqual([])
  })

  it('una repeticion (replayed) NO se difunde: se reenvia SOLO a quien la repite, con los mismos bytes', async () => {
    const { send, publish, sent } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: true }),
    )

    await send()

    expect(publish).not.toHaveBeenCalled()
    expect(sent()).toEqual([JSON.parse(JSON.stringify(toBattleEventWire(ROOM_ID, EVENT)))])
  })

  it('la difusion se hace DESPUES de que el caso de uso termino (persistir antes de difundir)', async () => {
    const order: string[] = []
    const { handler, attack, publish, socket } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: false }),
    )

    attack.execute.mockImplementation(async () => {
      await Promise.resolve()
      order.push('persistido')

      return { event: EVENT, replayed: false }
    })
    publish.mockImplementation(() => order.push('difundido'))

    await handler.handle(socket, 'sub-a', VALID, publish)

    expect(order).toEqual(['persistido', 'difundido'])
  })

  it('si el caso de uso falla NO se difunde nada', async () => {
    const { send, publish } = handlerWith(() => Promise.reject(new NotYourTurnError(ROOM_ID)))

    await send()

    expect(publish).not.toHaveBeenCalled()
  })

  it('un fallo al difundir no revierte ni rechaza: el estado ya esta persistido (resume lo recupera)', async () => {
    const { send, publish, sent, errors } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: false }),
    )

    publish.mockImplementation(() => {
      throw new Error('socket roto')
    })

    await send()

    expect(sent()).toEqual([])
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(errors)).not.toContain('socket roto')
  })

  it.each([
    [new RoomNotFoundError(ROOM_ID), AttackRejectionCode.RoomNotFound],
    [new RoomAccessForbiddenError(ROOM_ID), AttackRejectionCode.NotAParticipant],
    [new InvalidCommandIdError(), AttackRejectionCode.InvalidCommandId],
    [new BattleNotInProgressError(ROOM_ID, 'PREPARING'), AttackRejectionCode.BattleNotActive],
    [new NotYourTurnError(ROOM_ID), AttackRejectionCode.NotYourTurn],
    [new InvalidTargetError(ROOM_ID), 'INVALID_TARGET'],
    [new SameTeamTargetError(), 'SAME_TEAM_TARGET'],
    [new TargetUnavailableError(), 'TARGET_UNAVAILABLE'],
    [new ActorUnavailableError(), 'ACTOR_UNAVAILABLE'],
    [new UnsupportedCombatProfileError('x'), 'UNSUPPORTED_COMBAT_PROFILE'],
    [new RoomConflictError(ROOM_ID), AttackRejectionCode.CommandConflict],
  ])(
    '%s -> command.rejected %s (con command y commandId, solo al remitente)',
    async (error, code) => {
      const { send, sent } = handlerWith(() => Promise.reject(error))

      await send()

      expect(sent()).toEqual([
        { type: 'command.rejected', command: 'attack', commandId: 'cmd-1', code },
      ])
    },
  )

  it('un error inesperado responde INTERNAL_ERROR sin filtrar su mensaje y lo registra sin datos sensibles', async () => {
    const { send, sent, errors } = handlerWith(() => Promise.reject(new Error('secreto-interno')))

    await send()

    expect(sent()).toEqual([
      { type: 'command.rejected', command: 'attack', commandId: 'cmd-1', code: 'INTERNAL_ERROR' },
    ])
    expect(JSON.stringify(sent())).not.toContain('secreto-interno')
    expect(JSON.stringify(errors)).not.toContain('secreto-interno')
    expect(errors[0]).toMatchObject({ roomId: ROOM_ID, commandId: 'cmd-1', error: 'Error' })
  })

  it('un socket ya cerrado no recibe nada (ni rechazos ni repeticiones)', async () => {
    const { send, socket, sent } = handlerWith(() => Promise.reject(new NotYourTurnError(ROOM_ID)))

    socket.close()
    await send()

    expect(sent()).toEqual([])
  })
})
