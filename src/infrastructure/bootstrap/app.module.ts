import { Module, type CanActivate } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import type { Db } from 'mongodb'

import { BattleRoomController } from '../../adapters/inbound/http/battle-room.controller'
import { RealtimeTicketController } from '../../adapters/inbound/http/realtime-ticket.controller'
import { HealthController } from '../../adapters/inbound/http/health.controller'
import { READINESS_CHECKS, VERSION_REPORT } from '../../adapters/inbound/http/tokens.health'
import {
  BATTLE_RANDOM,
  BATTLE_RANDOM_SEQUENCE,
  BATTLE_DEADLINE_SCHEDULER_OPTIONS,
  BATTLE_DEADLINE_SETTLER,
  BATTLE_FINALIZER,
  CANCEL_BATTLE_ROOM,
  COMPLETE_BATTLE_TURN,
  CONSUME_REALTIME_TICKET,
  CREATE_BATTLE_ROOM,
  EXECUTE_BASIC_ATTACK,
  USE_SKILL,
  GET_BATTLE_ROOM,
  ISSUE_REALTIME_TICKET,
  JOIN_BATTLE_ROOM,
  LEAVE_BATTLE_ROOM,
  LIST_AVAILABLE_BATTLE_ROOMS,
  PROCESS_BATTLE_DEADLINES,
  RECOVER_BATTLE_DEADLINES,
  RESUME_BATTLE,
  ROOM_COMMAND_LOCK,
  START_BATTLE,
} from '../../adapters/inbound/http/tokens'
import { AnonymousIdentityGuard } from '../../adapters/inbound/http/auth/anonymous.guard'
import { InternalServiceGuard } from '../../adapters/inbound/http/auth/internal-service.guard'
import { JwtAuthGuard } from '../../adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../adapters/inbound/http/auth/roles.guard'
import { BasicAttackRealtimeHandler } from '../../adapters/inbound/ws/BasicAttackRealtimeHandler'
import { SkillRealtimeHandler } from '../../adapters/inbound/ws/SkillRealtimeHandler'
import { BattleRoomRealtimeGateway } from '../../adapters/inbound/ws/BattleRoomRealtimeGateway'
import { ChannelLock } from '../../adapters/inbound/ws/ChannelLock'
import { ChatRealtimeHandler } from '../../adapters/inbound/ws/ChatRealtimeHandler'
import { CognitoTokenVerifier } from '../../adapters/outbound/identity/CognitoTokenVerifier'
import { AccountHttpClient } from '../../adapters/outbound/http/AccountHttpClient'
import { PlayerInventoryHttpClient } from '../../adapters/outbound/http/PlayerInventoryHttpClient'
import { InMemoryBattleRoomRepository } from '../../adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryChatMessageRepository } from '../../adapters/outbound/persistence/InMemoryChatMessageRepository'
import { MongoBattleRoomRepository } from '../../adapters/outbound/persistence/MongoBattleRoomRepository'
import { MongoChatMessageRepository } from '../../adapters/outbound/persistence/MongoChatMessageRepository'
import { InMemoryRealtimeTicketStore } from '../../adapters/outbound/realtime/InMemoryRealtimeTicketStore'
import { CryptoRealtimeTicketCodec } from '../../adapters/outbound/system/CryptoRealtimeTicketCodec'
import { CdfUniformIndexMapper } from '../../adapters/outbound/system/CdfUniformIndexMapper'
import { InMemoryBattleDeadlineBook } from '../../adapters/outbound/system/InMemoryBattleDeadlineBook'
import { InMemoryBattlePresenceRegistry } from '../../adapters/outbound/system/InMemoryBattlePresenceRegistry'
import {
  DEFAULT_BATTLE_DEADLINE_SCHEDULER_OPTIONS,
  IntervalBattleDeadlineScheduler,
} from '../../adapters/outbound/system/IntervalBattleDeadlineScheduler'
import { LoggingBattleResultPublisher } from '../../adapters/outbound/system/LoggingBattleResultPublisher'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../adapters/outbound/system/UuidGenerator'
import {
  ACCOUNT_BATTLE_PROFILE,
  type AccountBattleProfilePort,
} from '../../application/ports/AccountBattleProfilePort'
import {
  BATTLE_ROOM_REPOSITORY,
  type BattleRoomRepositoryPort,
} from '../../application/ports/BattleRoomRepositoryPort'
import {
  BATTLE_CONNECTIONS,
  type BattleConnectionsPort,
} from '../../application/ports/BattleConnectionsPort'
import {
  BATTLE_DEADLINE_BOOK,
  type BattleDeadlineBookPort,
} from '../../application/ports/BattleDeadlineBookPort'
import {
  BATTLE_PRESENCE,
  type BattlePresencePort,
} from '../../application/ports/BattlePresencePort'
import {
  BATTLE_RESULT_PUBLISHER,
  type BattleResultPublisherPort,
} from '../../application/ports/BattleResultPublisherPort'
import {
  BATTLE_ROOM_RELEASE,
  type BattleRoomReleasePort,
} from '../../application/ports/BattleRoomReleasePort'
import {
  CHAT_MESSAGE_REPOSITORY,
  type ChatMessageRepositoryPort,
} from '../../application/ports/ChatMessageRepositoryPort'
import { CLOCK, type ClockPort } from '../../application/ports/ClockPort'
import { ID_GENERATOR, type IdGeneratorPort } from '../../application/ports/IdGeneratorPort'
import {
  PLAYER_INVENTORY_EQUIPPED_HERO,
  type PlayerInventoryEquippedHeroPort,
} from '../../application/ports/PlayerInventoryEquippedHeroPort'
import {
  RANDOM_SEQUENCE_FACTORY,
  type RandomSequenceFactoryPort,
  type RandomSequencePort,
} from '../../application/ports/RandomSequencePort'
import type { RoomCommandLockPort } from '../../application/ports/RoomCommandLockPort'
import {
  BATTLE_EVENT_PUBLISHER,
  type BattleEventPublisherPort,
} from '../../application/ports/BattleEventPublisherPort'
import {
  REALTIME_NOTIFIER,
  type RealtimeNotifierPort,
} from '../../application/ports/RealtimeNotifierPort'
import {
  REALTIME_TICKET_CODEC,
  REALTIME_TICKET_STORE,
  type RealtimeTicketCodecPort,
  type RealtimeTicketStorePort,
} from '../../application/ports/RealtimeTicketPort'
import { createBoundedRandom } from '../../application/services/BoundedRandom'
import { BattleDeadlineSettler } from '../../application/services/BattleDeadlineSettler'
import { BattleFinalizer } from '../../application/services/BattleFinalizer'
import { RandomSeed } from '../../domain/value-objects/RandomSeed'
import type { BoundedRandom } from '../../domain/policies/TurnOrderPolicy'
import { CompleteBattleTurn } from '../../application/use-cases/CompleteBattleTurn'
import { ExecuteBasicAttack } from '../../application/use-cases/ExecuteBasicAttack'
import { ProcessBattleDeadlines } from '../../application/use-cases/ProcessBattleDeadlines'
import { RecoverBattleDeadlines } from '../../application/use-cases/RecoverBattleDeadlines'
import { UseSkill } from '../../application/use-cases/UseSkill'
import { GetBattleRoom } from '../../application/use-cases/GetBattleRoom'
import { ResumeBattle } from '../../application/use-cases/ResumeBattle'
import { StartBattle } from '../../application/use-cases/StartBattle'
import {
  ConsumeRealtimeTicket,
  IssueRealtimeTicket,
} from '../../application/use-cases/RealtimeTickets'
import { TOKEN_VERIFIER, type TokenVerifierPort } from '../../application/ports/TokenVerifierPort'
import { AuthorizeChatChannel } from '../../application/use-cases/AuthorizeChatChannel'
import { CancelBattleRoom } from '../../application/use-cases/CancelBattleRoom'
import { CreateBattleRoom } from '../../application/use-cases/CreateBattleRoom'
import { JoinBattleRoom } from '../../application/use-cases/JoinBattleRoom'
import { LeaveBattleRoom } from '../../application/use-cases/LeaveBattleRoom'
import { ListAvailableBattleRooms } from '../../application/use-cases/ListAvailableBattleRooms'
import { ReadChatHistory } from '../../application/use-cases/ReadChatHistory'
import { SendChatMessage } from '../../application/use-cases/SendChatMessage'
import { ChatRateLimiter } from '../../domain/policies/ChatRateLimiter'
import { UpstreamServiceError } from '../../application/errors/UpstreamErrors'
import { AuthMode, loadConfig, PersistenceDriver, type AppConfig } from '../config/env'
import type { ReadinessCheck, VersionReport } from '../health/health'
import { createLogger, type Logger } from '../observability/logger'
import { LOGGER } from '../observability/logger-token'
import { createMongoClient, databaseOf, pingDatabase } from '../persistence/database'

export const APP_CONFIG = Symbol('AppConfig')
export { LOGGER }
export const DATABASE = Symbol('Database')
export const DATABASE_LIFECYCLE = Symbol('DatabaseLifecycle')

/**
 * Servicios autorizados a llamar a las rutas `@InternalOnly()` de Combat.
 *
 * Es la lista de consumidores que ADR-019 declara. Anadir uno es una decision
 * de arquitectura, no un ajuste de configuracion: por eso vive en codigo, donde
 * cambiarla exige un Pull Request revisado.
 */
export const INTERNAL_CALLERS: readonly string[] = ['missions']

/**
 * Identidad de Combat al llamar a las rutas `@InternalOnly()` de OTROS
 * servicios (HU-15.2, RF-15): el valor que Account y Player-Inventory
 * esperan encontrar en `X-Internal-Service` y en su propia lista de
 * llamadores permitidos.
 */
export const OUTBOUND_SERVICE_NAME = 'combat'

/**
 * Raiz de composicion.
 *
 * Es el unico lugar donde se eligen implementaciones concretas. Los casos de
 * uso son clases planas sin decoradores de NestJS: se registran aqui con
 * fabricas explicitas, de modo que la capa de aplicacion permanece
 * independiente del framework.
 */
@Module({
  controllers: [HealthController, BattleRoomController, RealtimeTicketController],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(process.env),
    },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig): Logger =>
        createLogger({
          level: config.logLevel,
          service: config.serviceName,
          version: config.version,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: CLOCK,
      useFactory: (): ClockPort => new SystemClock(),
    },
    {
      provide: DATABASE,
      useFactory: async (config: AppConfig, logger: Logger): Promise<Db | null> => {
        if (config.persistenceDriver !== PersistenceDriver.Mongo) {
          logger.warn('in_memory_persistence', {
            detail: 'PERSISTENCE_DRIVER=memory: el estado se pierde al reiniciar el servicio.',
          })

          return null
        }

        // `loadConfig` ya garantiza que MONGODB_URI existe con este driver.
        if (config.databaseUrl === null) {
          throw new Error('MONGODB_URI es obligatorio con PERSISTENCE_DRIVER=mongo.')
        }

        const options = { uri: config.databaseUrl }
        const client = createMongoClient(options)

        // Se conecta AQUI y no en la primera consulta: un motor inalcanzable
        // debe impedir el arranque, no aparecer como error de una peticion.
        await client.connect()

        // El esquema NO se migra aqui: es un paso explicito, `npm run migrate`.
        return databaseOf(client, options)
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: DATABASE_LIFECYCLE,
      useFactory: (db: Db | null): { onModuleDestroy: () => Promise<void> } => ({
        onModuleDestroy: async (): Promise<void> => {
          await db?.client.close()
        },
      }),
      inject: [DATABASE],
    },
    {
      provide: TOKEN_VERIFIER,
      useFactory: (config: AppConfig, logger: Logger): TokenVerifierPort => {
        if (config.cognito === null) {
          // No se devuelve un verificador que acepte cualquier cosa: con
          // AUTH_MODE=disabled el guard que lo usaria no se registra.
          logger.warn('authentication_disabled', {
            detail: 'AUTH_MODE=disabled: ninguna ruta verifica quien realiza la peticion.',
          })

          return {
            verify: (): Promise<never> =>
              Promise.reject(new Error('No hay verificador de testimonios configurado.')),
          }
        }

        return new CognitoTokenVerifier(config.cognito)
      },
      inject: [APP_CONFIG, LOGGER],
    },
    // El orden importa: NestJS ejecuta los guards globales en el orden en que se
    // declaran. Primero la identidad, despues los roles, despues el contrato
    // interno, que solo actua sobre rutas `@InternalOnly()`.
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        verifier: TokenVerifierPort,
      ): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new JwtAuthGuard(reflector, verifier)
          : new AnonymousIdentityGuard(),
      inject: [APP_CONFIG, Reflector, TOKEN_VERIFIER],
    },
    {
      provide: APP_GUARD,
      useFactory: (config: AppConfig, reflector: Reflector): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new RolesGuard(reflector)
          : { canActivate: (): boolean => true },
      inject: [APP_CONFIG, Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        clock: ClockPort,
        logger: Logger,
      ): CanActivate =>
        new InternalServiceGuard({
          reflector,
          secret: config.internalServiceAuthSecret,
          allowedServices: INTERNAL_CALLERS,
          clock,
          logger,
        }),
      inject: [APP_CONFIG, Reflector, CLOCK, LOGGER],
    },
    {
      provide: ID_GENERATOR,
      useFactory: (): IdGeneratorPort => new UuidGenerator(),
    },
    // HU-24 (RF-24): motor pseudoaleatorio centralizado (MT19937 -> Box-Muller ->
    // indice 1..8000). Todavia NINGUN caso de uso lo consume: queda registrado
    // para HU-25 (tabla de efectos) y la futura simulacion para Missions. La
    // estrategia normal -> indice es la decision tecnica provisional de HU-24
    // (docs/hu-24-randomness-engine.md) y se elige AQUI, no dentro del generador.
    // No hay semilla global: cada batalla o simulacion crea su secuencia.
    {
      provide: RANDOM_SEQUENCE_FACTORY,
      useFactory: (): RandomSequenceFactoryPort =>
        new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper()),
    },
    // HU-15.2 (RF-15): clientes HTTP internos hacia Account y
    // Player-Inventory. Sin INTERNAL_SERVICE_AUTH_SECRET configurado, se
    // registra un puerto que rechaza toda llamada con UpstreamServiceError
    // en vez de firmar peticiones con un secreto vacio -- mismo criterio que
    // TOKEN_VERIFIER arriba con AUTH_MODE=disabled.
    {
      provide: ACCOUNT_BATTLE_PROFILE,
      useFactory: (
        config: AppConfig,
        clock: ClockPort,
        logger: Logger,
      ): AccountBattleProfilePort => {
        if (config.internalServiceAuthSecret === null || config.accountServiceBaseUrl === null) {
          logger.warn('account_client_sin_configurar', {
            detail: 'ACCOUNT_SERVICE_BASE_URL o INTERNAL_SERVICE_AUTH_SECRET no configurados.',
          })

          return {
            getBattleProfile: (): Promise<never> =>
              Promise.reject(new UpstreamServiceError('account', 'no_configurado')),
          }
        }

        return new AccountHttpClient({
          baseUrl: config.accountServiceBaseUrl,
          callerService: OUTBOUND_SERVICE_NAME,
          secret: config.internalServiceAuthSecret,
          clock,
          logger,
          timeoutMs: config.internalHttpTimeoutMs,
        })
      },
      inject: [APP_CONFIG, CLOCK, LOGGER],
    },
    {
      provide: PLAYER_INVENTORY_EQUIPPED_HERO,
      useFactory: (
        config: AppConfig,
        clock: ClockPort,
        logger: Logger,
      ): PlayerInventoryEquippedHeroPort => {
        if (
          config.internalServiceAuthSecret === null ||
          config.playerInventoryServiceBaseUrl === null
        ) {
          logger.warn('player_inventory_client_sin_configurar', {
            detail:
              'PLAYER_INVENTORY_SERVICE_BASE_URL o INTERNAL_SERVICE_AUTH_SECRET no configurados.',
          })

          return {
            getEquippedHero: (): Promise<never> =>
              Promise.reject(new UpstreamServiceError('player-inventory', 'no_configurado')),
          }
        }

        return new PlayerInventoryHttpClient({
          baseUrl: config.playerInventoryServiceBaseUrl,
          callerService: OUTBOUND_SERVICE_NAME,
          secret: config.internalServiceAuthSecret,
          clock,
          logger,
          timeoutMs: config.internalHttpTimeoutMs,
        })
      },
      inject: [APP_CONFIG, CLOCK, LOGGER],
    },
    // HU-14: salas de batalla. `PERSISTENCE_DRIVER=memory` respalda pruebas
    // de integracion sin motor real, igual que el resto de repositorios del
    // proyecto cuando adoptan ese patron.
    {
      provide: BATTLE_ROOM_REPOSITORY,
      useFactory: (db: Db | null): BattleRoomRepositoryPort =>
        db === null ? new InMemoryBattleRoomRepository() : new MongoBattleRoomRepository(db),
      inject: [DATABASE],
    },
    {
      provide: CREATE_BATTLE_ROOM,
      useFactory: (
        rooms: BattleRoomRepositoryPort,
        ids: IdGeneratorPort,
        clock: ClockPort,
      ): CreateBattleRoom => new CreateBattleRoom(rooms, ids, clock),
      inject: [BATTLE_ROOM_REPOSITORY, ID_GENERATOR, CLOCK],
    },
    {
      provide: LIST_AVAILABLE_BATTLE_ROOMS,
      useFactory: (rooms: BattleRoomRepositoryPort): ListAvailableBattleRooms =>
        new ListAvailableBattleRooms(rooms),
      inject: [BATTLE_ROOM_REPOSITORY],
    },
    {
      provide: CANCEL_BATTLE_ROOM,
      useFactory: (rooms: BattleRoomRepositoryPort): CancelBattleRoom =>
        new CancelBattleRoom(rooms),
      inject: [BATTLE_ROOM_REPOSITORY],
    },
    {
      provide: JOIN_BATTLE_ROOM,
      useFactory: (
        rooms: BattleRoomRepositoryPort,
        clock: ClockPort,
        accountProfiles: AccountBattleProfilePort,
        equippedHeroes: PlayerInventoryEquippedHeroPort,
      ): JoinBattleRoom => new JoinBattleRoom(rooms, clock, accountProfiles, equippedHeroes),
      inject: [
        BATTLE_ROOM_REPOSITORY,
        CLOCK,
        ACCOUNT_BATTLE_PROFILE,
        PLAYER_INVENTORY_EQUIPPED_HERO,
      ],
    },
    {
      provide: LEAVE_BATTLE_ROOM,
      useFactory: (rooms: BattleRoomRepositoryPort): LeaveBattleRoom => new LeaveBattleRoom(rooms),
      inject: [BATTLE_ROOM_REPOSITORY],
    },
    // HU-13 (RF-13): chat del lobby y de las salas. Mensajes propios de Combat
    // (ADR-019, data-ownership). `PERSISTENCE_DRIVER=memory` respalda pruebas y
    // desarrollo, igual que el repositorio de salas.
    {
      provide: CHAT_MESSAGE_REPOSITORY,
      useFactory: (db: Db | null): ChatMessageRepositoryPort =>
        db === null ? new InMemoryChatMessageRepository() : new MongoChatMessageRepository(db),
      inject: [DATABASE],
    },
    {
      provide: ChatRealtimeHandler,
      useFactory: (
        config: AppConfig,
        rooms: BattleRoomRepositoryPort,
        messages: ChatMessageRepositoryPort,
        accountProfiles: AccountBattleProfilePort,
        clock: ClockPort,
        ids: IdGeneratorPort,
        logger: Logger,
      ): ChatRealtimeHandler => {
        const authorize = new AuthorizeChatChannel(rooms)

        return new ChatRealtimeHandler({
          authorize,
          readHistory: new ReadChatHistory(messages, clock, config.chat.historyLimit),
          sender: new SendChatMessage(
            authorize,
            messages,
            accountProfiles,
            new ChatRateLimiter(config.chat.rateLimitMessages, config.chat.rateLimitWindowMs),
            clock,
            ids,
            {
              maxMessageLength: config.chat.maxMessageLength,
              retentionMs: config.chat.retentionMs,
            },
          ),
          logger,
        })
      },
      inject: [
        APP_CONFIG,
        BATTLE_ROOM_REPOSITORY,
        CHAT_MESSAGE_REPOSITORY,
        ACCOUNT_BATTLE_PROFILE,
        CLOCK,
        ID_GENERATOR,
        LOGGER,
      ],
    },
    // HU-15.2 (RF-15, ADR-020): gateway WebSocket nativo. Provider normal de
    // Nest (no un controlador): `BattleRoomController` lo consume a traves
    // del puerto `REALTIME_NOTIFIER`, nunca de la clase concreta.
    // HU-17 (RF-17, ADR-020): tickets de un solo uso, lectura/recuperacion de la
    // batalla y el gateway completo (ticket, `seq`, `resume`, latido).
    {
      provide: REALTIME_TICKET_CODEC,
      useFactory: (): RealtimeTicketCodecPort => new CryptoRealtimeTicketCodec(),
    },
    {
      provide: REALTIME_TICKET_STORE,
      useFactory: (): RealtimeTicketStorePort => new InMemoryRealtimeTicketStore(),
    },
    {
      provide: ISSUE_REALTIME_TICKET,
      useFactory: (
        codec: RealtimeTicketCodecPort,
        store: RealtimeTicketStorePort,
        clock: ClockPort,
      ): IssueRealtimeTicket => new IssueRealtimeTicket(codec, store, clock),
      inject: [REALTIME_TICKET_CODEC, REALTIME_TICKET_STORE, CLOCK],
    },
    {
      provide: CONSUME_REALTIME_TICKET,
      useFactory: (
        codec: RealtimeTicketCodecPort,
        store: RealtimeTicketStorePort,
        clock: ClockPort,
      ): ConsumeRealtimeTicket => new ConsumeRealtimeTicket(codec, store, clock),
      inject: [REALTIME_TICKET_CODEC, REALTIME_TICKET_STORE, CLOCK],
    },
    {
      provide: GET_BATTLE_ROOM,
      useFactory: (rooms: BattleRoomRepositoryPort): GetBattleRoom => new GetBattleRoom(rooms),
      inject: [BATTLE_ROOM_REPOSITORY],
    },
    {
      provide: RESUME_BATTLE,
      useFactory: (rooms: BattleRoomRepositoryPort): ResumeBattle => new ResumeBattle(rooms),
      inject: [BATTLE_ROOM_REPOSITORY],
    },
    // HU-17: UNICA secuencia pseudoaleatoria de proceso para las decisiones de
    // la cola de turnos. Se crea UNA vez al arrancar con la semilla validada por
    // HU-26 (`COMBAT_RANDOM_SEED`, por defecto 3.000.000) y cada seleccion
    // AVANZA su estado: no se reinicia por batalla (una semilla constante por
    // batalla produciria siempre el mismo equipo inicial). No es una politica
    // de semilla por batalla ni persiste el cursor: ver docs/hu-17-turn-order.md.
    {
      provide: BATTLE_RANDOM_SEQUENCE,
      useFactory: (
        factory: RandomSequenceFactoryPort,
        config: AppConfig,
        logger: Logger,
      ): RandomSequencePort => {
        logger.info('battle_random_sequence_ready', { source: 'HU-24' })

        return factory.create(RandomSeed.create(config.randomSeed))
      },
      inject: [RANDOM_SEQUENCE_FACTORY, APP_CONFIG, LOGGER],
    },
    // HU-18: la cola de turnos (HU-17) y los golpes (Ataque, efecto y Dano) consumen
    // la MISMA secuencia de proceso: dos secuencias con la misma semilla producirian
    // las mismas tiradas en dos sitios distintos.
    {
      provide: BATTLE_RANDOM,
      useFactory: (sequence: RandomSequencePort): BoundedRandom => createBoundedRandom(sequence),
      inject: [BATTLE_RANDOM_SEQUENCE],
    },
    // IMPORTANTE: el gateway se registra como CLASE, no con `useFactory`. Nest solo
    // descubre y monta un `@WebSocketGateway` cuando el proveedor es la propia
    // clase (con `useFactory` su metatype es la fabrica y el gateway no llega a
    // escuchar: el upgrade a WebSocket responde 404). Sus dependencias se
    // inyectan con `@Inject` en el constructor.
    BattleRoomRealtimeGateway,
    {
      provide: REALTIME_NOTIFIER,
      useExisting: BattleRoomRealtimeGateway,
    },
    {
      provide: BATTLE_EVENT_PUBLISHER,
      useExisting: BattleRoomRealtimeGateway,
    },
    // HU-21 (RF-21): piezas de la finalizacion de batalla. La presencia y el
    // libro de vencimientos viven en memoria (ADR-020: una sola replica); el
    // gateway es tambien el liberador de conexiones y el consultor de conexiones
    // (solo lectura), y el publicador de resultados SOLO escribe un registro
    // hasta que HU-22/23/29/30/09 definan su transporte.
    {
      provide: BATTLE_PRESENCE,
      useFactory: (): BattlePresencePort => new InMemoryBattlePresenceRegistry(),
    },
    {
      provide: BATTLE_DEADLINE_BOOK,
      useFactory: (): BattleDeadlineBookPort => new InMemoryBattleDeadlineBook(),
    },
    {
      provide: BATTLE_RESULT_PUBLISHER,
      useFactory: (logger: Logger): BattleResultPublisherPort =>
        new LoggingBattleResultPublisher(logger),
      inject: [LOGGER],
    },
    {
      provide: BATTLE_ROOM_RELEASE,
      useExisting: BattleRoomRealtimeGateway,
    },
    {
      provide: BATTLE_CONNECTIONS,
      useExisting: BattleRoomRealtimeGateway,
    },
    {
      provide: BATTLE_FINALIZER,
      useFactory: (
        book: BattleDeadlineBookPort,
        presence: BattlePresencePort,
        notifier: RealtimeNotifierPort,
        release: BattleRoomReleasePort,
        results: BattleResultPublisherPort,
        logger: Logger,
      ): BattleFinalizer => new BattleFinalizer(book, presence, notifier, release, results, logger),
      inject: [
        BATTLE_DEADLINE_BOOK,
        BATTLE_PRESENCE,
        REALTIME_NOTIFIER,
        BATTLE_ROOM_RELEASE,
        BATTLE_RESULT_PUBLISHER,
        LOGGER,
      ],
    },
    {
      provide: BATTLE_DEADLINE_SETTLER,
      useFactory: (
        rooms: BattleRoomRepositoryPort,
        presence: BattlePresencePort,
        book: BattleDeadlineBookPort,
        clock: ClockPort,
        events: BattleEventPublisherPort,
        finalizer: BattleFinalizer,
      ): BattleDeadlineSettler =>
        new BattleDeadlineSettler(rooms, presence, book, clock, events, finalizer),
      inject: [
        BATTLE_ROOM_REPOSITORY,
        BATTLE_PRESENCE,
        BATTLE_DEADLINE_BOOK,
        CLOCK,
        BATTLE_EVENT_PUBLISHER,
        BATTLE_FINALIZER,
      ],
    },
    {
      provide: PROCESS_BATTLE_DEADLINES,
      useFactory: (
        rooms: BattleRoomRepositoryPort,
        book: BattleDeadlineBookPort,
        lock: RoomCommandLockPort,
        settler: BattleDeadlineSettler,
      ): ProcessBattleDeadlines => new ProcessBattleDeadlines(rooms, book, lock, settler),
      inject: [
        BATTLE_ROOM_REPOSITORY,
        BATTLE_DEADLINE_BOOK,
        ROOM_COMMAND_LOCK,
        BATTLE_DEADLINE_SETTLER,
      ],
    },
    {
      provide: RECOVER_BATTLE_DEADLINES,
      useFactory: (
        rooms: BattleRoomRepositoryPort,
        presence: BattlePresencePort,
        book: BattleDeadlineBookPort,
        clock: ClockPort,
      ): RecoverBattleDeadlines => new RecoverBattleDeadlines(rooms, presence, book, clock),
      inject: [BATTLE_ROOM_REPOSITORY, BATTLE_PRESENCE, BATTLE_DEADLINE_BOOK, CLOCK],
    },
    {
      provide: BATTLE_DEADLINE_SCHEDULER_OPTIONS,
      useValue: DEFAULT_BATTLE_DEADLINE_SCHEDULER_OPTIONS,
    },
    {
      provide: IntervalBattleDeadlineScheduler,
      useFactory: (
        book: BattleDeadlineBookPort,
        process: ProcessBattleDeadlines,
        recover: RecoverBattleDeadlines,
        clock: ClockPort,
        logger: Logger,
        options: typeof DEFAULT_BATTLE_DEADLINE_SCHEDULER_OPTIONS,
      ): IntervalBattleDeadlineScheduler =>
        new IntervalBattleDeadlineScheduler(book, process, recover, clock, logger, options),
      inject: [
        BATTLE_DEADLINE_BOOK,
        PROCESS_BATTLE_DEADLINES,
        RECOVER_BATTLE_DEADLINES,
        CLOCK,
        LOGGER,
        BATTLE_DEADLINE_SCHEDULER_OPTIONS,
      ],
    },
    {
      provide: START_BATTLE,
      useFactory: (
        rooms: BattleRoomRepositoryPort,
        clock: ClockPort,
        equippedHeroes: PlayerInventoryEquippedHeroPort,
        random: BoundedRandom,
        publisher: BattleEventPublisherPort,
        presence: BattlePresencePort,
        book: BattleDeadlineBookPort,
        connections: BattleConnectionsPort,
      ): StartBattle =>
        new StartBattle(
          rooms,
          clock,
          equippedHeroes,
          random,
          publisher,
          presence,
          book,
          connections,
        ),
      inject: [
        BATTLE_ROOM_REPOSITORY,
        CLOCK,
        PLAYER_INVENTORY_EQUIPPED_HERO,
        BATTLE_RANDOM,
        BATTLE_EVENT_PUBLISHER,
        BATTLE_PRESENCE,
        BATTLE_DEADLINE_BOOK,
        BATTLE_CONNECTIONS,
      ],
    },
    // Sin ruta publica: lo invocaran las acciones validas de HU-18/HU-19 al
    // terminar un turno. Web nunca decide `turno + 1`.
    {
      provide: COMPLETE_BATTLE_TURN,
      useFactory: (
        rooms: BattleRoomRepositoryPort,
        clock: ClockPort,
        publisher: BattleEventPublisherPort,
      ): CompleteBattleTurn => new CompleteBattleTurn(rooms, clock, publisher),
      inject: [BATTLE_ROOM_REPOSITORY, CLOCK, BATTLE_EVENT_PUBLISHER],
    },
    // HU-18 (RF-18): ataque basico. Es la unica accion de juego expuesta por el
    // WebSocket (`attack`); no hay ruta HTTP. Los comandos de una sala se serializan
    // (una replica, ADR-020).
    {
      provide: ROOM_COMMAND_LOCK,
      useFactory: (): RoomCommandLockPort => new ChannelLock(),
    },
    {
      provide: EXECUTE_BASIC_ATTACK,
      useFactory: (
        rooms: BattleRoomRepositoryPort,
        clock: ClockPort,
        sequence: RandomSequencePort,
        lock: RoomCommandLockPort,
        settler: BattleDeadlineSettler,
      ): ExecuteBasicAttack => new ExecuteBasicAttack(rooms, clock, sequence, lock, settler),
      inject: [
        BATTLE_ROOM_REPOSITORY,
        CLOCK,
        BATTLE_RANDOM_SEQUENCE,
        ROOM_COMMAND_LOCK,
        BATTLE_DEADLINE_SETTLER,
      ],
    },
    {
      provide: BasicAttackRealtimeHandler,
      useFactory: (
        attack: ExecuteBasicAttack,
        finalizer: BattleFinalizer,
        logger: Logger,
      ): BasicAttackRealtimeHandler => new BasicAttackRealtimeHandler(attack, logger, finalizer),
      inject: [EXECUTE_BASIC_ATTACK, BATTLE_FINALIZER, LOGGER],
    },
    // HU-19 (RF-19): habilidad especial por el mismo WebSocket (`useSkill`). Comparte el bloqueo
    // de sala y la secuencia HU-24 con el ataque basico, y lo reutiliza (mismo bloqueo, sin pedirlo
    // otra vez) cuando el Poder no alcanza y HU-11 fuerza el ataque basico.
    {
      provide: USE_SKILL,
      useFactory: (
        rooms: BattleRoomRepositoryPort,
        clock: ClockPort,
        sequence: RandomSequencePort,
        lock: RoomCommandLockPort,
        basicAttack: ExecuteBasicAttack,
        settler: BattleDeadlineSettler,
      ): UseSkill => new UseSkill(rooms, clock, sequence, lock, basicAttack, settler),
      inject: [
        BATTLE_ROOM_REPOSITORY,
        CLOCK,
        BATTLE_RANDOM_SEQUENCE,
        ROOM_COMMAND_LOCK,
        EXECUTE_BASIC_ATTACK,
        BATTLE_DEADLINE_SETTLER,
      ],
    },
    {
      provide: SkillRealtimeHandler,
      useFactory: (
        skill: UseSkill,
        logger: Logger,
        finalizer: BattleFinalizer,
      ): SkillRealtimeHandler => new SkillRealtimeHandler(skill, logger, finalizer),
      inject: [USE_SKILL, LOGGER, BATTLE_FINALIZER],
    },
    {
      provide: READINESS_CHECKS,
      useFactory: (db: Db | null): readonly ReadinessCheck[] =>
        // Con MongoDB la sonda va hasta el motor. En memoria no hay
        // dependencia externa que comprobar, y no se inventa una.
        db === null ? [] : [{ name: 'mongodb', check: () => pingDatabase(db) }],
      inject: [DATABASE],
    },
    {
      provide: VERSION_REPORT,
      useFactory: (config: AppConfig): VersionReport => ({
        service: config.serviceName,
        version: config.version,
        nodeEnv: config.nodeEnv,
      }),
      inject: [APP_CONFIG],
    },
  ],
})
export class AppModule {}
