import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { REWARD_WORKFLOW_REPOSITORY } from '../../src/adapters/inbound/http/tokens'
import { InMemoryRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryRewardWorkflowRepository'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Contrato HTTP de HU-22 (`GET /v1/combat/rooms/:roomId/reward`,
 * `hu-22-reward-contract-v1` §10) sobre `PERSISTENCE_DRIVER=memory`.
 */
const ROOM_ID = '11111111-1111-4111-8111-111111111111'

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-ganador': { subject: 'sub-ganador', email: null, roles: new Set([Role.Player]) },
  'token-otro': { subject: 'sub-otro', email: null, roles: new Set([Role.Player]) },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
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

describe('GET /api/v1/combat/rooms/:roomId/reward', () => {
  let app: INestApplication
  let restore: () => void
  let repository: InMemoryRewardWorkflowRepository

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',
      PERSISTENCE_DRIVER: 'memory',
    })

    repository = new InMemoryRewardWorkflowRepository()

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(REWARD_WORKFLOW_REPOSITORY)
      .useValue(repository)
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

  const path = `/api/v1/combat/rooms/${ROOM_ID}/reward`

  it('exige testimonio de identidad', async () => {
    expect((await request(app.getHttpServer()).get(path)).status).toBe(401)
  })

  it('un roomId que no es UUID responde 400, no 500', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/combat/rooms/no-es-uuid/reward')
      .set('Authorization', 'Bearer token-ganador')

    expect(response.status).toBe(400)
  })

  it('sin workflow para ese jugador: 200 con NONE y todo null (no 404)', async () => {
    const response = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer token-otro')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      creditsEarned: null,
      balance: null,
      victoryProgress: null,
      weeklyChestCount: null,
      chestEarned: null,
      rewardDelivery: 'NONE',
      reward: null,
    })
  })

  it('devuelve SOLO el estado del jugador autenticado, con cofre confirmado', async () => {
    const workflow = await repository.createIfAbsent(
      {
        battleId: ROOM_ID,
        playerId: 'sub-ganador',
        teamLabel: 'A',
        seat: 0,
        creditsAmount: 4,
        victoryCreditsAmount: 4,
        finishedAt: new Date('2026-09-22T10:06:00.000Z'),
      },
      'op-http-1',
    )
    await repository.applyWalletResult(workflow.id, {
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      chestEarned: true,
    })
    await repository.applySelection(workflow.id, {
      productId: 'product-http',
      sku: 'sku-http',
      name: 'Espada de prueba',
      inventoryOperationId: 'inv-op-http-1',
    })
    await repository.applyCompleted(workflow.id)

    const asWinner = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer token-ganador')

    expect(asWinner.body).toEqual({
      creditsEarned: 4,
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      chestEarned: true,
      rewardDelivery: 'CONFIRMED',
      reward: { productId: 'product-http', sku: 'sku-http', name: 'Espada de prueba' },
    })

    // sub-otro no participo en este workflow: sigue viendo NONE, no el
    // resultado ajeno.
    const asOther = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer token-otro')

    expect(asOther.body.rewardDelivery).toBe('NONE')
  })
})
