import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const SECRET = 'mission-simulations-test-secret'
const PATH = '/api/internal/v1/combat/simulations'

const BODY = {
  schemaVersion: 1,
  operationId: 'mission:enr-sim-1:simulate',
  enrollmentId: 'enr-sim-1',
  missionId: 'msn-templo',
  difficulty: 'NORMAL',
  enemyStatMultiplier: 1,
  timeBudget: 'PT12H',
  hero: {
    heroId: 'hero-1',
    profile: {
      subtype: 'GUERRERO_TANQUE',
      effectiveStats: {
        health: 60,
        power: 10,
        attack: 15,
        defense: 10,
        damage: { mode: 'FIXED', amount: 20 },
      },
      abilities: [],
    },
  },
  strategy: { version: null, rotations: [], fallback: 'BASIC_ATTACK' },
  encounters: [
    {
      index: 1,
      kind: 'BOSS',
      powerStep: null,
      enemies: [
        {
          enemyRef: 'guardian-eterno',
          name: 'Guardian Eterno',
          count: 1,
          profile: { maxHealth: 30, attack: 6, defense: 6, damage: 2, ai: 'BOSS' },
        },
      ],
    },
  ],
  master: null,
}

describe('POST /api/internal/v1/combat/simulations', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    const original = {
      AUTH_MODE: process.env.AUTH_MODE,
      PERSISTENCE_DRIVER: process.env.PERSISTENCE_DRIVER,
      INTERNAL_SERVICE_AUTH_SECRET: process.env.INTERNAL_SERVICE_AUTH_SECRET,
    }
    process.env.AUTH_MODE = 'disabled'
    process.env.PERSISTENCE_DRIVER = 'memory'
    process.env.INTERNAL_SERVICE_AUTH_SECRET = SECRET
    restore = () => {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
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

  const signed = (body: unknown, service = 'missions') => {
    const timestamp = String(Date.now())
    return request(app.getHttpServer())
      .post(PATH)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set(
        'x-internal-signature',
        signInternalRequest(SECRET, { service, method: 'POST', path: PATH, timestamp, body }),
      )
      .send(body as object)
  }

  it('rejects unsigned and unauthorized service calls before processing', async () => {
    expect((await request(app.getHttpServer()).post(PATH).send(BODY)).status).toBe(401)
    expect((await signed(BODY, 'catalog')).status).toBe(401)
  })

  it('returns the contract 400 for malformed requests without reserving the operation', async () => {
    const malformed = { ...BODY, timeBudget: '12h' }
    const rejected = await signed(malformed)
    expect(rejected.status).toBe(400)
    expect(rejected.body.code).toBe('SCHEMA_INVALID')

    const accepted = await signed(BODY)
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({
      operationId: BODY.operationId,
      combatOutcome: 'HERO_VICTORIOUS',
      summary: { encountersCompleted: 1, bossDefeated: true },
    })
  })

  it('keeps a matching retry pending, regardless of JSON object key order', async () => {
    const reordered = Object.fromEntries(Object.entries(BODY).reverse())
    const response = await signed(reordered)
    expect(response.status).toBe(200)
    expect(response.body.simulationId).toBe((await signed(BODY)).body.simulationId)
    expect(response.body.combatLog).toEqual((await signed(BODY)).body.combatLog)
  })

  it('rejects reuse of operationId with a different request', async () => {
    const changed = await signed({ ...BODY, timeBudget: 'PT13H' })
    expect(changed.status).toBe(409)
    expect(changed.body.code).toBe('OPERATION_ID_REUSED')
  })

  it('rejects unresolved content before reserving the operation', async () => {
    const response = await signed({
      ...BODY,
      operationId: 'mission:enr-sim-2:simulate',
      difficulty: 'MYTHIC',
      enemyStatMultiplier: null,
      master: { evaluationPoints: [], maxAppearances: 1, candidates: [] },
    })
    expect(response.status).toBe(422)
    expect(response.body.code).toBe('MISSION_CONTENT_INVALID')
  })

  it('rejects a malformed hero ability as content instead of crashing during turns', async () => {
    const response = await signed({
      ...BODY,
      operationId: 'mission:enr-invalid-ability:simulate',
      hero: {
        ...BODY.hero,
        profile: {
          ...BODY.hero.profile,
          abilities: [{ abilityId: 'bad-skill', name: 'Incompleta', effects: [] }],
        },
      },
    })
    expect(response.status).toBe(422)
    expect(response.body.code).toBe('MISSION_CONTENT_INVALID')
  })

  it('defeats a boss, rolls its drop and records a Master fight', async () => {
    const response = await signed({
      ...BODY,
      operationId: 'mission:enr-sim-boss-loot:simulate',
      bossDrops: [{ label: 'Trofeo del jefe', probability: 1, rolls: 2, productId: null }],
      master: {
        evaluationPoints: [{ afterEncounter: 1 }],
        maxAppearances: 1,
        candidates: [
          {
            masterRef: 'maestro-1',
            subtype: 'PICARO_VENENO',
            probability: 1,
            levelOffset: 2,
            profile: { maxHealth: 20, attack: 4, defense: 4, damage: 1, ai: 'AGGRESSIVE' },
            epicRef: 'epica-1',
          },
        ],
      },
    })
    expect(response.status).toBe(200)
    expect(response.body.summary).toMatchObject({
      bossDefeated: true,
      loot: [{ label: 'Trofeo del jefe', quantity: 2, productId: null }],
      master: {
        appeared: true,
        defeated: true,
        evaluations: [{ afterEncounter: 1, masterRef: 'maestro-1', appeared: true }],
        encounters: [{ masterRef: 'maestro-1', outcome: 'DEFEATED', levelOffset: 2 }],
      },
    })
  })
})
