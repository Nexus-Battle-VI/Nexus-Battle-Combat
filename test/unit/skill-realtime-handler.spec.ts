import {
  SkillRealtimeHandler,
  SkillRejectionCode,
  USE_SKILL_COMMAND,
  parseSkillCommand,
} from '../../src/adapters/inbound/ws/SkillRealtimeHandler'
import { toBattleEventWire } from '../../src/application/dto/BattleEventDto'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../src/application/errors/ApplicationError'
import type { UseSkill, UseSkillResult } from '../../src/application/use-cases/UseSkill'
import type { BattleEvent } from '../../src/domain/entities/BattleEvent'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  InvalidCommandIdError,
  InvalidTargetError,
  NotYourTurnError,
  SameTeamTargetError,
  SkillOnCooldownError,
  SkillsNotAvailableError,
  TargetUnavailableError,
  UnknownSkillError,
  UnsupportedCombatProfileError,
  UnsupportedSkillEffectError,
} from '../../src/domain/errors/BattleErrors'
import { ROOM_ID, silentLogger } from '../fixtures/battle'
import { FakeSocket } from '../fixtures/fake-socket'
import { SHIELD_STRIKE_ID } from '../fixtures/skills'

/**
 * Comando `useSkill` de HU-19 en el adaptador de WebSocket: forma estricta del mensaje,
 * traduccion de errores a `command.rejected` con codigos estables y difusion SOLO tras persistir.
 * La logica de combate NO se ejerce aqui (tiene su propia suite).
 */
const VALID = {
  type: 'useSkill',
  commandId: 'cmd-1',
  roomId: ROOM_ID,
  abilityId: SHIELD_STRIKE_ID,
  target: { teamLabel: 'B', seat: 0 },
}

const EVENT: BattleEvent = {
  seq: 2,
  type: 'skillUsed',
  occurredAt: new Date('2026-09-21T10:00:00.000Z'),
  payload: {
    commandId: 'cmd-1',
    completedPosition: 0,
    actor: { teamLabel: 'A', seat: 0 },
    target: { teamLabel: 'B', seat: 0 },
    skill: {
      abilityId: SHIELD_STRIKE_ID,
      name: 'Golpe con escudo',
      powerCost: { mode: 'FIXED', amount: 2 },
      chargeTurns: 1,
    },
    power: { before: 10, after: 8 },
    cooldown: { remainingTurns: 1 },
    bonus: { attack: 2, damage: 0 },
    resolution: {
      attackValue: 17,
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

const handlerWith = (execute: () => Promise<UseSkillResult>) => {
  const skill = { execute: jest.fn(execute) } as unknown as UseSkill
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

  return {
    handler: new SkillRealtimeHandler(skill, logger),
    skill: skill as unknown as { execute: jest.Mock },
    publish,
    socket,
    errors,
    infos,
    send: (message: Record<string, unknown> = VALID) =>
      new SkillRealtimeHandler(skill, logger).handle(socket, 'sub-a', message, publish),
    sent: () => socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>),
  }
}

describe('parseSkillCommand — la forma del mensaje es estricta', () => {
  it('acepta exactamente type, commandId, roomId, abilityId y target { teamLabel, seat }', () => {
    expect(parseSkillCommand(VALID)).toEqual({
      commandId: 'cmd-1',
      roomId: ROOM_ID,
      abilityId: SHIELD_STRIKE_ID,
      target: { teamLabel: 'B', seat: 0 },
    })
  })

  it.each([
    ['effects', { effects: [] }],
    ['cost', { cost: 0 }],
    ['powerCost', { powerCost: 0 }],
    ['power', { power: 99 }],
    ['cooldown', { cooldown: 0 }],
    ['damage', { damage: 99 }],
    ['attackBonus', { attackBonus: 99 }],
    ['heroId', { heroId: 'x' }],
    ['attackerId', { attackerId: 'a1' }],
    ['currentTurn', { currentTurn: 1 }],
    ['targets', { targets: [{ teamLabel: 'B', seat: 0 }] }],
    ['area', { area: true }],
    ['seed', { seed: 1 }],
    ['kind (la epica no tiene comando en v1)', { kind: 'EPIC' }],
    ['epicId', { epicId: SHIELD_STRIKE_ID }],
  ])('rechaza una clave de mas (%s): el servidor no la ignora en silencio', (_name, extra) => {
    expect(parseSkillCommand({ ...VALID, ...extra })).toBeNull()
  })

  it.each(['commandId', 'roomId', 'abilityId', 'target'])('rechaza si falta %s', (key) => {
    const rest: Record<string, unknown> = { ...VALID }

    Reflect.deleteProperty(rest, key)

    expect(parseSkillCommand(rest)).toBeNull()
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
    ['UUID de sala que no es v4', { ...VALID, roomId: '11111111-1111-1111-8111-111111111111' }],
    ['abilityId ausente como cadena', { ...VALID, abilityId: 42 }],
    ['abilityId que no es UUID', { ...VALID, abilityId: 'golpe-con-escudo' }],
    ['abilityId vacio', { ...VALID, abilityId: '' }],
    ['abilityId con punto (clave de documento)', { ...VALID, abilityId: 'a.b' }],
  ]

  it.each(MALFORMED)('rechaza %s', (_label, message) => {
    expect(parseSkillCommand(message)).toBeNull()
  })

  it('abilityId acepta un UUID de cualquier version (es el productId de Catalog), no solo v4', () => {
    expect(
      parseSkillCommand({ ...VALID, abilityId: '2e97537a-675c-171a-b902-4fcf369083a8' }),
    ).not.toBeNull()
    expect(
      parseSkillCommand({ ...VALID, abilityId: '2E97537A-675C-461A-B902-4FCF369083A8' }),
    ).not.toBeNull()
  })

  it('un commandId cadena pero vacio o largo NO es mal formado: lo rechaza el dominio como INVALID_COMMAND_ID', () => {
    expect(parseSkillCommand({ ...VALID, commandId: '' })).not.toBeNull()
    expect(parseSkillCommand({ ...VALID, commandId: 'x'.repeat(500) })).not.toBeNull()
  })
})

describe('SkillRealtimeHandler', () => {
  it('el nombre del comando es `useSkill` (ADR-020)', () => {
    expect(USE_SKILL_COMMAND).toBe('useSkill')
  })

  it('un mensaje mal formado responde MALFORMED_COMMAND SOLO al remitente y no llega al caso de uso', async () => {
    const { send, skill, sent, publish } = handlerWith(() =>
      Promise.reject(new Error('no debe llamarse')),
    )

    await send({ ...VALID, cost: 0 })

    expect(skill.execute).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(sent()).toEqual([
      {
        type: 'command.rejected',
        command: 'useSkill',
        commandId: 'cmd-1',
        code: 'MALFORMED_COMMAND',
      },
    ])
  })

  it('un mal formado sin commandId de tipo cadena no lo inventa', async () => {
    const { send, sent } = handlerWith(() => Promise.reject(new Error('no debe llamarse')))

    await send({ type: 'useSkill', commandId: 42 })

    expect(sent()).toEqual([
      { type: 'command.rejected', command: 'useSkill', code: 'MALFORMED_COMMAND' },
    ])
  })

  it('el actor es el `sub` de la conexion y la habilidad viaja SOLO como identificador', async () => {
    const { send, skill } = handlerWith(() => Promise.resolve({ event: EVENT, replayed: false }))

    await send()

    expect(skill.execute).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      requesterId: 'sub-a',
      commandId: 'cmd-1',
      abilityId: SHIELD_STRIKE_ID,
      target: { teamLabel: 'B', seat: 0 },
    })
  })

  it('una habilidad nueva se DIFUNDE una vez con el evento persistido y el remitente no recibe un duplicado directo', async () => {
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

  it('el ataque basico al que se degrada una habilidad se difunde igual (mismo evento persistido)', async () => {
    const degraded: BattleEvent = {
      seq: 2,
      type: 'basicAttackResolved',
      occurredAt: EVENT.occurredAt,
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
        degradedFrom: {
          command: 'useSkill',
          abilityId: SHIELD_STRIKE_ID,
          reason: 'INSUFFICIENT_POWER',
        },
        battle: (EVENT.payload as { battle: never }).battle,
      },
    }
    const { send, publish } = handlerWith(() =>
      Promise.resolve({ event: degraded, replayed: false }),
    )

    await send()

    expect(publish).toHaveBeenCalledWith(ROOM_ID, [degraded])
    expect(JSON.parse(JSON.stringify(toBattleEventWire(ROOM_ID, degraded)))).toMatchObject({
      type: 'basicAttackResolved',
      degradedFrom: {
        command: 'useSkill',
        abilityId: SHIELD_STRIKE_ID,
        reason: 'INSUFFICIENT_POWER',
      },
    })
  })

  it('la difusion se hace DESPUES de que el caso de uso termino (persistir antes de difundir)', async () => {
    const order: string[] = []
    const { handler, skill, publish, socket } = handlerWith(() =>
      Promise.resolve({ event: EVENT, replayed: false }),
    )

    skill.execute.mockImplementation(async () => {
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
    [new RoomNotFoundError(ROOM_ID), SkillRejectionCode.RoomNotFound],
    [new RoomAccessForbiddenError(ROOM_ID), SkillRejectionCode.NotAParticipant],
    [new InvalidCommandIdError(), SkillRejectionCode.InvalidCommandId],
    [new BattleNotInProgressError(ROOM_ID, 'PREPARING'), SkillRejectionCode.BattleNotActive],
    [new NotYourTurnError(ROOM_ID), SkillRejectionCode.NotYourTurn],
    [new RoomConflictError(ROOM_ID), SkillRejectionCode.CommandConflict],
    [new InvalidTargetError(ROOM_ID), 'INVALID_TARGET'],
    [new SameTeamTargetError(), 'SAME_TEAM_TARGET'],
    [new TargetUnavailableError(), 'TARGET_UNAVAILABLE'],
    [new ActorUnavailableError(), 'ACTOR_UNAVAILABLE'],
    [new UnsupportedCombatProfileError('sin perfil'), 'UNSUPPORTED_COMBAT_PROFILE'],
    [new SkillsNotAvailableError(), 'SKILLS_NOT_AVAILABLE'],
    [new UnknownSkillError(), 'UNKNOWN_SKILL'],
    [new UnsupportedSkillEffectError('un motivo interno'), 'UNSUPPORTED_SKILL_EFFECT'],
    [new SkillOnCooldownError(), 'SKILL_ON_COOLDOWN'],
  ])('%p -> command.rejected {code: %s}, solo al remitente', async (error, code) => {
    const { send, sent, publish } = handlerWith(() => Promise.reject(error))

    await send()

    expect(sent()).toEqual([
      { type: 'command.rejected', command: 'useSkill', commandId: 'cmd-1', code },
    ])
    expect(publish).not.toHaveBeenCalled()
  })

  it('el Poder insuficiente NO es un codigo de rechazo: no existe INSUFFICIENT_POWER en la lista', () => {
    expect(JSON.stringify(SkillRejectionCode)).not.toMatch(/POWER/)
  })

  it('el motivo interno de un efecto no soportado se registra pero NUNCA viaja al cliente', async () => {
    const { send, sent, infos } = handlerWith(() =>
      Promise.reject(new UnsupportedSkillEffectError('un efecto con duracion exige estado')),
    )

    await send()

    expect(JSON.stringify(sent())).not.toMatch(/duracion|estado|reason/)
    expect(JSON.stringify(infos)).toContain('un efecto con duracion exige estado')
  })

  it('un fallo inesperado responde INTERNAL_ERROR sin exponer su mensaje', async () => {
    const { send, sent, errors } = handlerWith(() =>
      Promise.reject(new Error('detalle interno secreto')),
    )

    await send()

    expect(sent()).toEqual([
      { type: 'command.rejected', command: 'useSkill', commandId: 'cmd-1', code: 'INTERNAL_ERROR' },
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
})
