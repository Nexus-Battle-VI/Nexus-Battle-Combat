import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { StakeRejectedError } from '../../src/application/errors/StakeIntegrationErrors'
import {
  ACCOUNT_BATTLE_PROFILE,
  type AccountBattleProfilePort,
} from '../../src/application/ports/AccountBattleProfilePort'
import {
  PLAYER_INVENTORY_EQUIPPED_HERO,
  type PlayerInventoryEquippedHeroPort,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import {
  WALLET_STAKE_PORT,
  type WalletStakePort,
  type WalletStakeReleaseCommand,
  type WalletStakeReserveCommand,
  type WalletStakeSettleCommand,
} from '../../src/application/ports/WalletStakePort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { equippedHeroFixture } from '../fixtures/equipped-hero'

/**
 * Contrato HTTP de la apuesta de HU-23 sobre `PERSISTENCE_DRIVER=memory`: el
 * modulo completo (guards, DTOs, controlador, casos de uso, servicios de
 * reserva/liberacion y repositorio en memoria) con un doble del puerto de
 * Wallet. La firma HMAC real entre los dos procesos la cubre la validacion
 * cross-service (Task #437).
 */
const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-creador': { subject: 'sujeto-creador', email: null, roles: new Set([Role.Player]) },
  'token-otro': { subject: 'sujeto-otro', email: null, roles: new Set([Role.Player]) },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const stubAccountProfiles: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `nombre-${subject}`, avatarUrl: null }),
}

const stubEquippedHeroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(equippedHeroFixture({ playerId, heroId: `heroe-${playerId}` })),
}

interface WalletStakeCalls {
  readonly reserve: WalletStakeReserveCommand[]
  readonly release: WalletStakeReleaseCommand[]
  readonly settle: WalletStakeSettleCommand[]
}

const walletCalls: WalletStakeCalls = { reserve: [], release: [], settle: [] }
let reserveRejects = false

const walletStakeStub: WalletStakePort = {
  reserve: (command) => {
    walletCalls.reserve.push(command)

    if (reserveRejects) {
      return Promise.reject(
        new StakeRejectedError('wallet', 'sin disponible', 'INSUFFICIENT_AVAILABLE_BALANCE'),
      )
    }

    return Promise.resolve({
      operationId: command.operationId,
      applied: true,
      holdId: command.operationId,
      balance: 100,
      reserved: command.amount,
      available: 100 - command.amount,
    })
  },
  release: (command) => {
    walletCalls.release.push(command)

    return Promise.resolve({
      operationId: command.operationId,
      applied: true,
      holdId: command.holdId,
      balance: 100,
      reserved: 0,
      available: 100,
    })
  },
  settle: (command) => {
    walletCalls.settle.push(command)

    return Promise.resolve({ operationId: command.operationId, applied: true, results: [] })
  },
}

const withEnv = (values: Record<string, string>): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('POST /api/v1/combat/rooms con apuesta (HU-23)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',
      PERSISTENCE_DRIVER: 'memory',
    })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(stubAccountProfiles)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(stubEquippedHeroes)
      .overrideProvider(WALLET_STAKE_PORT)
      .useValue(walletStakeStub)
      .compile()

    app = moduleRef.createNestApplication()

    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  beforeEach(() => {
    walletCalls.reserve.length = 0
    walletCalls.release.length = 0
    walletCalls.settle.length = 0
    reserveRejects = false
  })

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`)

  const createRoomWithStake = async (amount: number): Promise<string> => {
    const response = await authed('token-creador')(
      request(app.getHttpServer())
        .post('/api/v1/combat/rooms')
        .send({
          mode: 'PVP',
          teamConfigs: [
            { capacity: 2, initialParticipants: [{ kind: 'HUMAN', stake: { amount } }] },
            { capacity: 2 },
          ],
          reward: { amount: 0 },
        }),
    )

    expect(response.status).toBe(201)

    return response.body.id as string
  }

  it('crear con apuesta: reserva sincrona y el creador ve SU apuesta (S-01)', async () => {
    const response = await authed('token-creador')(
      request(app.getHttpServer())
        .post('/api/v1/combat/rooms')
        .send({
          mode: 'PVP',
          teamConfigs: [
            { capacity: 2, initialParticipants: [{ kind: 'HUMAN', stake: { amount: 10 } }] },
            { capacity: 2 },
          ],
          reward: { amount: 0 },
        }),
    )

    expect(response.status).toBe(201)
    expect(response.body.id).toMatch(UUID_V4_PATTERN)
    expect(walletCalls.reserve).toHaveLength(1)
    expect(walletCalls.reserve[0]).toMatchObject({
      playerId: 'sujeto-creador',
      amount: 10,
    })
    expect(response.body.stakePool).toEqual({ total: 10 })
    expect(response.body.teams[0].participants[0].stake).toEqual({
      amount: 10,
      status: 'ACTIVE',
    })
  })

  it('saldo insuficiente en Wallet: 422 con el MISMO code y sin sala (S-03)', async () => {
    reserveRejects = true

    const response = await authed('token-creador')(
      request(app.getHttpServer())
        .post('/api/v1/combat/rooms')
        .send({
          mode: 'PVP',
          teamConfigs: [
            { capacity: 2, initialParticipants: [{ kind: 'HUMAN', stake: { amount: 10 } }] },
            { capacity: 2 },
          ],
          reward: { amount: 0 },
        }),
    )

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('INSUFFICIENT_AVAILABLE_BALANCE')
    expect(walletCalls.reserve).toHaveLength(1)
  })

  it('PVE con apuesta: 422 STAKE_NOT_ALLOWED_IN_PVE y Wallet nunca se llama (S-16)', async () => {
    const response = await authed('token-creador')(
      request(app.getHttpServer())
        .post('/api/v1/combat/rooms')
        .send({
          mode: 'PVE',
          teamConfigs: [
            { capacity: 2, initialParticipants: [{ kind: 'HUMAN', stake: { amount: 10 } }] },
            { capacity: 2, initialParticipants: [{ kind: 'AI' }] },
          ],
          reward: { amount: 0 },
        }),
    )

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('STAKE_NOT_ALLOWED_IN_PVE')
    expect(walletCalls.reserve).toHaveLength(0)
  })

  it('unirse con apuesta: reserva y el DTO oculta la apuesta ajena (§10)', async () => {
    const roomId = await createRoomWithStake(5)
    walletCalls.reserve.length = 0

    const response = await authed('token-otro')(
      request(app.getHttpServer())
        .post(`/api/v1/combat/rooms/${roomId}/join`)
        .send({ team: 'B', stake: { amount: 15 } }),
    )

    expect(response.status).toBe(200)
    expect(walletCalls.reserve).toHaveLength(1)
    expect(walletCalls.reserve[0]).toMatchObject({ playerId: 'sujeto-otro', amount: 15 })

    const joiner = response.body.teams[1].participants[0]
    expect(joiner.stake).toEqual({ amount: 15, status: 'ACTIVE' })
    // El rival (creador) no expone su apuesta, pero el agregado si suma.
    expect(response.body.teams[0].participants[0]).not.toHaveProperty('stake')
    expect(response.body.stakePool).toEqual({ total: 20 })
  })

  it('unirse con apuesta rechazada: 422 y el jugador NO queda en la sala (S-03)', async () => {
    const roomId = await createRoomWithStake(5)
    reserveRejects = true

    const response = await authed('token-otro')(
      request(app.getHttpServer())
        .post(`/api/v1/combat/rooms/${roomId}/join`)
        .send({ team: 'B', stake: { amount: 15 } }),
    )

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('INSUFFICIENT_AVAILABLE_BALANCE')

    const read = await authed('token-creador')(
      request(app.getHttpServer()).get(`/api/v1/combat/rooms/${roomId}`),
    )
    const playerIds = read.body.teams.flatMap((team: { participants: { playerId: string }[] }) =>
      team.participants.map((participant) => participant.playerId),
    )
    expect(playerIds).toEqual(['sujeto-creador'])
  })

  it('el listado no expone la apuesta de un rival, solo el agregado (S-04/§10)', async () => {
    const roomId = await createRoomWithStake(12)

    const response = await authed('token-otro')(
      request(app.getHttpServer()).get('/api/v1/combat/rooms'),
    )

    expect(response.status).toBe(200)

    interface ListedParticipant {
      readonly playerId: string | null
      readonly stake?: unknown
    }
    interface ListedRoom {
      readonly id: string
      readonly stakePool: { readonly total: number }
      readonly teams: readonly { readonly participants: readonly ListedParticipant[] }[]
    }

    const room = (response.body as readonly ListedRoom[]).find(
      (candidate) => candidate.id === roomId,
    )

    expect(room?.stakePool.total).toBe(12)
    for (const team of room?.teams ?? []) {
      for (const participant of team.participants) {
        if (participant.playerId !== 'sujeto-otro') {
          expect(participant).not.toHaveProperty('stake')
        }
      }
    }
  })
})
