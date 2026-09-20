import { Module, type CanActivate } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import type { Db } from 'mongodb'

import { BattleRoomController } from '../../adapters/inbound/http/battle-room.controller'
import { HealthController } from '../../adapters/inbound/http/health.controller'
import { READINESS_CHECKS, VERSION_REPORT } from '../../adapters/inbound/http/tokens.health'
import {
  CANCEL_BATTLE_ROOM,
  CREATE_BATTLE_ROOM,
  JOIN_BATTLE_ROOM,
  LEAVE_BATTLE_ROOM,
  LIST_AVAILABLE_BATTLE_ROOMS,
} from '../../adapters/inbound/http/tokens'
import { AnonymousIdentityGuard } from '../../adapters/inbound/http/auth/anonymous.guard'
import { InternalServiceGuard } from '../../adapters/inbound/http/auth/internal-service.guard'
import { JwtAuthGuard } from '../../adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../adapters/inbound/http/auth/roles.guard'
import { BattleRoomRealtimeGateway } from '../../adapters/inbound/ws/BattleRoomRealtimeGateway'
import { CognitoTokenVerifier } from '../../adapters/outbound/identity/CognitoTokenVerifier'
import { AccountHttpClient } from '../../adapters/outbound/http/AccountHttpClient'
import { PlayerInventoryHttpClient } from '../../adapters/outbound/http/PlayerInventoryHttpClient'
import { InMemoryBattleRoomRepository } from '../../adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { MongoBattleRoomRepository } from '../../adapters/outbound/persistence/MongoBattleRoomRepository'
import { CdfUniformIndexMapper } from '../../adapters/outbound/system/CdfUniformIndexMapper'
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
import { CLOCK, type ClockPort } from '../../application/ports/ClockPort'
import { ID_GENERATOR, type IdGeneratorPort } from '../../application/ports/IdGeneratorPort'
import {
  PLAYER_INVENTORY_EQUIPPED_HERO,
  type PlayerInventoryEquippedHeroPort,
} from '../../application/ports/PlayerInventoryEquippedHeroPort'
import {
  RANDOM_SEQUENCE_FACTORY,
  type RandomSequenceFactoryPort,
} from '../../application/ports/RandomSequencePort'
import { REALTIME_NOTIFIER } from '../../application/ports/RealtimeNotifierPort'
import { TOKEN_VERIFIER, type TokenVerifierPort } from '../../application/ports/TokenVerifierPort'
import { CancelBattleRoom } from '../../application/use-cases/CancelBattleRoom'
import { CreateBattleRoom } from '../../application/use-cases/CreateBattleRoom'
import { JoinBattleRoom } from '../../application/use-cases/JoinBattleRoom'
import { LeaveBattleRoom } from '../../application/use-cases/LeaveBattleRoom'
import { ListAvailableBattleRooms } from '../../application/use-cases/ListAvailableBattleRooms'
import { UpstreamServiceError } from '../../application/errors/UpstreamErrors'
import { AuthMode, loadConfig, PersistenceDriver, type AppConfig } from '../config/env'
import type { ReadinessCheck, VersionReport } from '../health/health'
import { createLogger, type Logger } from '../observability/logger'
import { createMongoClient, databaseOf, pingDatabase } from '../persistence/database'

export const APP_CONFIG = Symbol('AppConfig')
export const LOGGER = Symbol('Logger')
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
  controllers: [HealthController, BattleRoomController],
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
    // HU-15.2 (RF-15, ADR-020): gateway WebSocket nativo. Provider normal de
    // Nest (no un controlador): `BattleRoomController` lo consume a traves
    // del puerto `REALTIME_NOTIFIER`, nunca de la clase concreta.
    {
      provide: BattleRoomRealtimeGateway,
      useFactory: (
        verifier: TokenVerifierPort,
        rooms: BattleRoomRepositoryPort,
        logger: Logger,
      ): BattleRoomRealtimeGateway => new BattleRoomRealtimeGateway(verifier, rooms, logger),
      inject: [TOKEN_VERIFIER, BATTLE_ROOM_REPOSITORY, LOGGER],
    },
    {
      provide: REALTIME_NOTIFIER,
      useExisting: BattleRoomRealtimeGateway,
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
