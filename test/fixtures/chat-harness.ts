import { ChatRealtimeHandler } from '../../src/adapters/inbound/ws/ChatRealtimeHandler'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryChatMessageRepository } from '../../src/adapters/outbound/persistence/InMemoryChatMessageRepository'
import type { AccountBattleProfilePort } from '../../src/application/ports/AccountBattleProfilePort'
import type { ChatMessageRepositoryPort } from '../../src/application/ports/ChatMessageRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import { AuthorizeChatChannel } from '../../src/application/use-cases/AuthorizeChatChannel'
import { CreateBattleRoom } from '../../src/application/use-cases/CreateBattleRoom'
import { ReadChatHistory } from '../../src/application/use-cases/ReadChatHistory'
import { SendChatMessage } from '../../src/application/use-cases/SendChatMessage'
import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { ChatRateLimiter } from '../../src/domain/policies/ChatRateLimiter'
import type { Logger } from '../../src/infrastructure/observability/logger'

/** Reloj controlable: las pruebas de frontera de tiempo no falsean temporizadores globales. */
export class MutableClock implements ClockPort {
  constructor(private current: Date = new Date('2026-09-20T12:00:00.000Z')) {}

  now(): Date {
    return this.current
  }

  set(date: Date): void {
    this.current = date
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
}

export interface RecordedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly context: Readonly<Record<string, string | number | boolean | null>> | undefined
}

export const recordingLogger = (): { logger: Logger; logs: RecordedLog[] } => {
  const logs: RecordedLog[] = []
  const record =
    (level: RecordedLog['level']) =>
    (message: string, context?: RecordedLog['context']): void => {
      logs.push({ level, message, context })
    }

  return {
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    logs,
  }
}

/** UUID v4 deterministas: `uuid(1)`, `uuid(2)`, ... */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export interface ChatHarnessOptions {
  readonly rooms?: InMemoryBattleRoomRepository
  readonly messages?: ChatMessageRepositoryPort
  readonly clock?: MutableClock
  readonly maxMessageLength?: number
  readonly rateLimitMessages?: number
  readonly rateLimitWindowMs?: number
  readonly retentionMs?: number
  readonly historyLimit?: number
  readonly maxBufferedBytes?: number
  readonly accountProfiles?: AccountBattleProfilePort
  readonly logger?: Logger
}

/**
 * Pila completa del chat con dobles en memoria: casos de uso, limitador y
 * manejador. Los valores por defecto son los de produccion (500 caracteres, 5
 * mensajes cada 10 s, 7 dias, 50 de historial).
 */
export const buildChatHarness = (options: ChatHarnessOptions = {}) => {
  const rooms = options.rooms ?? new InMemoryBattleRoomRepository()
  const messages = options.messages ?? new InMemoryChatMessageRepository()
  const clock = options.clock ?? new MutableClock()
  const accountCalls: string[] = []

  const accountProfiles: AccountBattleProfilePort = options.accountProfiles ?? {
    getBattleProfile: (subject) => {
      accountCalls.push(subject)

      return Promise.resolve({ subject, displayName: `nombre-de-${subject}`, avatarUrl: null })
    },
  }

  let idCounter = 1000
  const ids: IdGeneratorPort = {
    generate: () => {
      idCounter += 1

      return uuid(idCounter)
    },
  }

  const authorize = new AuthorizeChatChannel(rooms)
  const readHistory = new ReadChatHistory(messages, clock, options.historyLimit ?? 50)
  const sender = new SendChatMessage(
    authorize,
    messages,
    accountProfiles,
    new ChatRateLimiter(options.rateLimitMessages ?? 5, options.rateLimitWindowMs ?? 10_000),
    clock,
    ids,
    {
      maxMessageLength: options.maxMessageLength ?? 500,
      retentionMs: options.retentionMs ?? 168 * 3_600_000,
    },
  )

  const recorded = recordingLogger()
  const logger = options.logger ?? recorded.logger

  const handler = new ChatRealtimeHandler({
    authorize,
    readHistory,
    sender,
    logger,
    ...(options.maxBufferedBytes === undefined
      ? {}
      : { maxBufferedBytes: options.maxBufferedBytes }),
  })

  return {
    rooms,
    messages,
    clock,
    authorize,
    readHistory,
    sender,
    handler,
    accountCalls,
    logs: recorded.logs,
  }
}

export type ChatHarness = ReturnType<typeof buildChatHarness>

/** Sala 2 contra 2 (PVP) sin participantes; `join` los va anadiendo. */
export const createRoom = async (
  rooms: InMemoryBattleRoomRepository,
  roomId: string,
  createdBy = 'creador',
): Promise<BattleRoom> => {
  const created = await new CreateBattleRoom(
    rooms,
    { generate: () => roomId },
    new MutableClock(),
  ).execute(createdBy, {
    mode: 'PVP',
    teamConfigs: [{ capacity: 2 }, { capacity: 2 }],
    reward: { amount: 0 },
  })

  const room = await rooms.findById(created.id)

  if (room === null) {
    throw new Error('la sala de prueba no se persistio')
  }

  return room
}

/** Incorpora un jugador HUMANO a la sala (con snapshot de nombre opcional). */
export const joinRoom = async (
  rooms: InMemoryBattleRoomRepository,
  roomId: string,
  playerId: string,
  displayName: string | null = null,
): Promise<BattleRoom> => {
  const room = await rooms.findById(roomId)

  if (room === null) {
    throw new Error('la sala de prueba no existe')
  }

  const joined = room.join(
    playerId,
    null,
    new Date('2026-09-20T12:00:00.000Z'),
    displayName,
    `heroe-${playerId}`,
  )

  return rooms.save(joined, room.version)
}

export const leaveRoom = async (
  rooms: InMemoryBattleRoomRepository,
  roomId: string,
  playerId: string,
): Promise<BattleRoom> => {
  const room = await rooms.findById(roomId)

  if (room === null) {
    throw new Error('la sala de prueba no existe')
  }

  return rooms.save(room.leave(playerId), room.version)
}

export const cancelRoom = async (
  rooms: InMemoryBattleRoomRepository,
  roomId: string,
  requestedBy = 'creador',
): Promise<BattleRoom> => {
  const room = await rooms.findById(roomId)

  if (room === null) {
    throw new Error('la sala de prueba no existe')
  }

  return rooms.save(room.cancel(requestedBy), room.version)
}
