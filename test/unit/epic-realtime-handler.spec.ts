import {
  EpicRealtimeHandler,
  EpicRejectionCode,
  USE_EPIC_COMMAND,
  parseEpicCommand,
} from '../../src/adapters/inbound/ws/EpicRealtimeHandler'
import { toBattleEventWire } from '../../src/application/dto/BattleEventDto'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../src/application/errors/ApplicationError'
import type { UseEpic, UseEpicResult } from '../../src/application/use-cases/UseEpic'
import type { BattleFinalizer } from '../../src/application/services/BattleFinalizer'
import type { BattleEvent } from '../../src/domain/entities/BattleEvent'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  EpicOnCooldownError,
  EpicTargetRequiredError,
  InvalidCommandIdError,
  InvalidHealTargetError,
  InvalidTargetError,
  NoEpicEquippedError,
  NotYourTurnError,
  SameTeamTargetError,
  SkillsNotAvailableError,
  TargetUnavailableError,
  UnsupportedCombatProfileError,
  UnsupportedEpicEffectError,
} from '../../src/domain/errors/BattleErrors'
import { ROOM_ID, silentLogger } from '../fixtures/battle'
import { FakeSocket } from '../fixtures/fake-socket'

/**
 * Comando `useEpic` (correccion HU-19/HU-31) en el adaptador de WebSocket: forma estricta del
 * mensaje, traduccion de errores a `command.rejected` con codigos estables y difusion SOLO tras
 * persistir. La mecanica de combate NO se ejerce aqui (ver `use-epic.spec.ts`).
 */
const VALID = { type: 'useEpic', commandId: 'cmd-1', roomId: ROOM_ID }
const VALID_WITH_TARGET = { ...VALID, target: { teamLabel: 'B', seat: 0 } }

const EVENT: BattleEvent = {
  seq: 2,
  type: 'epicUsed',
  occurredAt: new Date('2026-09-21T10:00:00.000Z'),
  payload: {
    commandId: 'cmd-1',
    completedPosition: 0,
    actor: { teamLabel: 'A', seat: 0 },
    epic: { epicProductId: '3f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f', name: 'Golpe de defensa' },
    power: { before: 10, after: 10 },
    cooldown: { remainingTurns: 2 },
    appliedEffects: 1,
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

const handlerWith = (
  execute: () => Promise<UseEpicResult>,
  finalizer: BattleFinalizer | null = null,
) => {
  const epic = { execute: jest.fn(execute) } as unknown as UseEpic
  const errors: Record<string, unknown>[] = []
  const infos: Record<string, unknown>[] = []
  const logger = {
    ...silentLogger,
    info: (
      _message: string,
      context: Readonly<Record<string, string | number | boolean | null>> = {},
    ) => {
      infos.push(context)
    },
    error: (
      _message: string,
      context: Readonly<Record<string, string | number | boolean | null>> = {},
    ) => {
      errors.push(context)
    },
  }
  const publish = jest.fn()
  const socket = new FakeSocket()
  const handler = new EpicRealtimeHandler(epic, logger, finalizer)

  return {
    handler,
    epic: epic as unknown as { execute: jest.Mock },
    publish,
    socket,
    errors,
    infos,
    send: (message: Record<string, unknown> = VALID) =>
      handler.handle(socket, 'sub-a', message, publish),
    sent: () => socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>),
  }
}

describe('parseEpicCommand — la forma del mensaje es estricta', () => {
  it('acepta exactamente type, commandId, roomId (sin target)', () => {
    expect(parseEpicCommand(VALID)).toEqual({ commandId: 'cmd-1', roomId: ROOM_ID })
  })

  it('acepta type, commandId, roomId y target cuando el cliente lo trae', () => {
    expect(parseEpicCommand(VALID_WITH_TARGET)).toEqual({
      commandId: 'cmd-1',
      roomId: ROOM_ID,
      target: { teamLabel: 'B', seat: 0 },
    })
  })

  it.each([
    ['abilityId (no hay epica que elegir)', { abilityId: 'x' }],
    ['epicId', { epicId: 'x' }],
    ['effects', { effects: [] }],
    ['power', { power: 99 }],
    ['cooldown', { cooldown: 0 }],
  ])('rechaza una clave de mas (%s): el servidor no la ignora en silencio', (_name, extra) => {
    expect(parseEpicCommand({ ...VALID, ...extra })).toBeNull()
  })

  it.each(['commandId', 'roomId'])('rechaza si falta %s', (key) => {
    const rest: Record<string, unknown> = { ...VALID }

    Reflect.deleteProperty(rest, key)

    expect(parseEpicCommand(rest)).toBeNull()
  })

  const withTarget = (target: unknown): Record<string, unknown> => ({ ...VALID, target })

  const MALFORMED: readonly (readonly [string, Record<string, unknown>])[] = [
    ['target como arreglo', withTarget([{ teamLabel: 'B', seat: 0 }])],
    ['target nulo', withTarget(null)],
    ['target sin seat', withTarget({ teamLabel: 'B' })],
    ['target con heroId', withTarget({ teamLabel: 'B', seat: 0, heroId: 'x' })],
    ['teamLabel vacio', withTarget({ teamLabel: '', seat: 0 })],
    ['seat negativo', withTarget({ teamLabel: 'B', seat: -1 })],
    ['seat decimal', withTarget({ teamLabel: 'B', seat: 1.5 })],
    ['seat texto', withTarget({ teamLabel: 'B', seat: '0' })],
    ['commandId numerico', { ...VALID, commandId: 42 }],
    ['roomId que no es UUID', { ...VALID, roomId: 'no-es-un-uuid' }],
  ]

  it.each(MALFORMED)('rechaza %s', (_label, message) => {
    expect(parseEpicCommand(message)).toBeNull()
  })

  it('un commandId cadena pero vacio o largo NO es mal formado: lo rechaza el dominio', () => {
    expect(parseEpicCommand({ ...VALID, commandId: '' })).not.toBeNull()
    expect(parseEpicCommand({ ...VALID, commandId: 'x'.repeat(500) })).not.toBeNull()
  })
})

describe('EpicRealtimeHandler', () => {
  it('el nombre del comando es `useEpic`', () => {
    expect(USE_EPIC_COMMAND).toBe('useEpic')
  })

  it('un mensaje mal formado responde MALFORMED_COMMAND SOLO al remitente y no llega al caso de uso', async () => {
    const { send, epic, sent, publish } = handlerWith(() =>
      Promise.reject(new Error('no debe llamarse')),
    )

    await send({ ...VALID, abilityId: 'x' })

    expect(epic.execute).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(sent()).toEqual([
      {
        type: 'command.rejected',
        command: 'useEpic',
        commandId: 'cmd-1',
        code: 'MALFORMED_COMMAND',
      },
    ])
  })

  it('el actor es el `sub` de la conexion; sin target cuando el cliente no lo trae', async () => {
    const { send, epic } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: false, followUp: [], finished: null }),
    )

    await send()

    expect(epic.execute).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      requesterId: 'sub-a',
      commandId: 'cmd-1',
    })
  })

  it('con target, se reenvia tal cual al caso de uso', async () => {
    const { send, epic } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: false, followUp: [], finished: null }),
    )

    await send(VALID_WITH_TARGET)

    expect(epic.execute).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      requesterId: 'sub-a',
      commandId: 'cmd-1',
      target: { teamLabel: 'B', seat: 0 },
    })
  })

  it('una epica nueva se DIFUNDE una vez con el evento persistido y el remitente no recibe un duplicado directo', async () => {
    const { send, publish, sent } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: false, followUp: [], finished: null }),
    )

    await send()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(ROOM_ID, [EVENT])
    expect(sent()).toEqual([])
  })

  it('una repeticion (replayed) NO se difunde: se reenvia SOLO a quien la repite', async () => {
    const { send, publish, sent } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: true, followUp: [], finished: null }),
    )

    await send()

    expect(publish).not.toHaveBeenCalled()
    expect(sent()).toEqual([JSON.parse(JSON.stringify(toBattleEventWire(ROOM_ID, EVENT)))])
  })

  it('si el caso de uso falla NO se difunde nada', async () => {
    const { send, publish } = handlerWith(() => Promise.reject(new NotYourTurnError(ROOM_ID)))

    await send()

    expect(publish).not.toHaveBeenCalled()
  })

  it('un fallo al difundir no revierte ni rechaza', async () => {
    const { send, publish, sent, errors } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: false, followUp: [], finished: null }),
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
    [new RoomNotFoundError(ROOM_ID), EpicRejectionCode.RoomNotFound],
    [new RoomAccessForbiddenError(ROOM_ID), EpicRejectionCode.NotAParticipant],
    [new InvalidCommandIdError(), EpicRejectionCode.InvalidCommandId],
    [new BattleNotInProgressError(ROOM_ID, 'PREPARING'), EpicRejectionCode.BattleNotActive],
    [new NotYourTurnError(ROOM_ID), EpicRejectionCode.NotYourTurn],
    [new RoomConflictError(ROOM_ID), EpicRejectionCode.CommandConflict],
    [new InvalidTargetError(ROOM_ID), 'INVALID_TARGET'],
    [new SameTeamTargetError(), 'SAME_TEAM_TARGET'],
    [new InvalidHealTargetError(), 'INVALID_HEAL_TARGET'],
    [new TargetUnavailableError(), 'TARGET_UNAVAILABLE'],
    [new ActorUnavailableError(), 'ACTOR_UNAVAILABLE'],
    [new UnsupportedCombatProfileError('sin perfil'), 'UNSUPPORTED_COMBAT_PROFILE'],
    [new SkillsNotAvailableError(), 'SKILLS_NOT_AVAILABLE'],
    [new NoEpicEquippedError(), 'NO_EPIC_EQUIPPED'],
    [new EpicOnCooldownError(), 'EPIC_ON_COOLDOWN'],
    [new EpicTargetRequiredError(), 'EPIC_TARGET_REQUIRED'],
  ])('%p -> command.rejected {code: %s}, solo al remitente', async (error, code) => {
    const { send, sent, publish } = handlerWith(() => Promise.reject(error))

    await send()

    expect(sent()).toEqual([
      { type: 'command.rejected', command: 'useEpic', commandId: 'cmd-1', code },
    ])
    expect(publish).not.toHaveBeenCalled()
  })

  it('el motivo interno de un efecto no soportado se registra pero NUNCA viaja al cliente', async () => {
    const { send, sent, infos } = handlerWith(() =>
      Promise.reject(new UnsupportedEpicEffectError('un efecto REFLECT_DAMAGE no esta soportado')),
    )

    await send()

    expect(JSON.stringify(sent())).not.toMatch(/REFLECT_DAMAGE|reason/)
    expect(JSON.stringify(infos)).toContain('un efecto REFLECT_DAMAGE no esta soportado')
  })

  it('un fallo inesperado responde INTERNAL_ERROR sin exponer su mensaje', async () => {
    const { send, sent, errors } = handlerWith(() =>
      Promise.reject(new Error('detalle interno secreto')),
    )

    await send()

    expect(sent()).toEqual([
      { type: 'command.rejected', command: 'useEpic', commandId: 'cmd-1', code: 'INTERNAL_ERROR' },
    ])
    expect(JSON.stringify(sent())).not.toContain('secreto')
    expect(JSON.stringify(errors)).not.toContain('secreto')
  })

  it('un socket cerrado no recibe nada (ni rechazo ni repeticion)', async () => {
    const { send, socket, sent } = handlerWith(() => Promise.reject(new NotYourTurnError(ROOM_ID)))

    socket.readyState = 3

    await send()

    expect(sent()).toEqual([])
  })

  it('una epica letal (dano directo) difunde ambos eventos en orden y DESPUES finaliza', async () => {
    const order: string[] = []
    const finalEvent: BattleEvent = {
      seq: 3,
      type: 'battleFinished',
      occurredAt: new Date('2026-09-21T10:05:00.000Z'),
      payload: {
        result: {
          reason: 'ELIMINATION',
          outcome: 'WIN',
          winnerTeamLabel: 'A',
          finishedAt: '2026-09-21T10:05:00.000Z',
          tiebreak: null,
          disconnected: null,
          teams: [],
          participants: [],
        },
        battle: EVENT.payload.battle as never,
      },
    } as unknown as BattleEvent
    const finalizer = {
      afterFinished: () => order.push('finalizado'),
    } as unknown as BattleFinalizer
    const { handler, publish, socket } = handlerWith(
      () =>
        Promise.resolve({
          event: EVENT,
          replayed: false,
          followUp: [finalEvent],
          finished: {} as never,
        }),
      finalizer,
    )

    publish.mockImplementation(() => order.push('difundido'))

    await handler.handle(socket, 'sub-a', VALID, publish)

    expect(publish).toHaveBeenCalledWith(ROOM_ID, [EVENT, finalEvent])
    expect(order).toEqual(['difundido', 'finalizado'])
  })
})
