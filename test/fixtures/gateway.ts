import { BattleRoomRealtimeGateway } from '../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import type { BasicAttackRealtimeHandler } from '../../src/adapters/inbound/ws/BasicAttackRealtimeHandler'
import type { ChatRealtimeHandler } from '../../src/adapters/inbound/ws/ChatRealtimeHandler'
import type { SkillRealtimeHandler } from '../../src/adapters/inbound/ws/SkillRealtimeHandler'
import { InMemoryBattleDeadlineBook } from '../../src/adapters/outbound/system/InMemoryBattleDeadlineBook'
import { InMemoryBattlePresenceRegistry } from '../../src/adapters/outbound/system/InMemoryBattlePresenceRegistry'
import type { RealtimeGatewayOptions } from '../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import type { BattleDeadlineBookPort } from '../../src/application/ports/BattleDeadlineBookPort'
import type { BattlePresencePort } from '../../src/application/ports/BattlePresencePort'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { ConsumeRealtimeTicket } from '../../src/application/use-cases/RealtimeTickets'
import type { ResumeBattle } from '../../src/application/use-cases/ResumeBattle'
import type { Logger } from '../../src/infrastructure/observability/logger'
import { clock as fixedClock, silentLogger } from './battle'

/**
 * Fabricante compartido del gateway para las suites de adaptador (HU-21):
 * centraliza los 11 argumentos del constructor y deja que cada suite sustituya
 * SOLO lo que ejerce. Los dobles inertes evitan repetir el mismo objeto en cada
 * archivo.
 */
export const noopChat = (): ChatRealtimeHandler =>
  ({
    handle: jest.fn().mockResolvedValue(undefined),
    onDisconnect: jest.fn(),
    onRoomUpdated: jest.fn().mockResolvedValue(undefined),
  }) as unknown as ChatRealtimeHandler

export const noopAttack = (): BasicAttackRealtimeHandler =>
  ({ handle: jest.fn() }) as unknown as BasicAttackRealtimeHandler

export const noopSkill = (): SkillRealtimeHandler =>
  ({ handle: jest.fn() }) as unknown as SkillRealtimeHandler

export interface BuildGatewayOptions {
  readonly consumeTicket: ConsumeRealtimeTicket
  readonly rooms: BattleRoomRepositoryPort
  readonly resumeBattle: ResumeBattle
  readonly logger?: Logger
  readonly chat?: ChatRealtimeHandler
  readonly attack?: BasicAttackRealtimeHandler
  readonly skill?: SkillRealtimeHandler
  readonly presence?: BattlePresencePort
  readonly book?: BattleDeadlineBookPort
  readonly clock?: ClockPort
  readonly options?: RealtimeGatewayOptions
}

export const buildGateway = (options: BuildGatewayOptions): BattleRoomRealtimeGateway =>
  new BattleRoomRealtimeGateway(
    options.consumeTicket,
    options.rooms,
    options.resumeBattle,
    options.logger ?? silentLogger,
    options.chat ?? noopChat(),
    options.attack ?? noopAttack(),
    options.skill ?? noopSkill(),
    options.presence ?? new InMemoryBattlePresenceRegistry(),
    options.book ?? new InMemoryBattleDeadlineBook(),
    options.clock ?? fixedClock,
    options.options ?? {},
  )
