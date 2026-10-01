import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import {
  ACCOUNT_BATTLE_PROFILE,
  type AccountBattleProfilePort,
} from '../../src/application/ports/AccountBattleProfilePort'
import {
  PLAYER_INVENTORY_EQUIPPED_HERO,
  type PlayerInventoryEquippedHeroPort,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import { BATTLE_HERO_COMMITMENTS } from '../../src/application/ports/BattleHeroCommitmentPort'
import {
  BATTLE_ROOM_REPOSITORY,
  type BattleRoomRepositoryPort,
} from '../../src/application/ports/BattleRoomRepositoryPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { equippedHeroFixture } from '../fixtures/equipped-hero'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'

/**
 * Rutas internas de torneo (Management#517, EN `tournament-rooms`):
 * creacion con roster fijo, inicio reutilizando StartBattle, y lectura
 * paginada del registro. Ejercita el modulo completo (guard HMAC,
 * controlador, casos de uso, repositorio en memoria) y el aislamiento del
 * lobby publico (listado, join, leave, cancel, start).
 */
const SECRET = 'tournament-rooms-test-secret'
const BASE_PATH = '/api/internal/v1/combat/tournament-rooms'
const ROOMS_PATH = '/api/v1/combat/rooms'

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-p1': { subject: 'p1', email: null, roles: new Set([Role.Player]) },
  'token-p2': { subject: 'p2', email: null, roles: new Set([Role.Player]) },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token) => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const accounts: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `nombre-de-${subject}`, avatarUrl: null }),
}

const heroDenylist = new Set<string>()
const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(
      heroDenylist.has(playerId)
        ? null
        : equippedHeroFixture({ playerId, heroId: `heroe-de-${playerId}`, loadoutVersion: 0 }),
    ),
}

const commitments = recordingBattleCommitments()

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

const CREATE_BODY = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  operationId: 'T1:E1',
  tournamentId: 'T1',
  encounterId: 'T1:E1',
  teams: [
    { teamId: 'equipo1', memberIds: ['p1', 'p2'] },
    { teamId: 'equipo2', memberIds: ['p3', 'p4'] },
  ],
  ...overrides,
})

describe('Management#517: rutas internas de tournament-rooms', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: SECRET,
      PERSISTENCE_DRIVER: 'memory',
    })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(accounts)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(heroes)
      .overrideProvider(BATTLE_HERO_COMMITMENTS)
      .useValue(commitments)
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
    heroDenylist.clear()
    commitments.commits.length = 0
    commitments.releases.length = 0
  })

  const http = () => request(app.getHttpServer())
  const auth = (token: string) => `Bearer ${token}`

  const signed = (
    method: 'post' | 'get',
    path: string,
    body: unknown = {},
    service = 'tournament',
  ) => {
    const timestamp = String(Date.now())
    // El guard firma/verifica SIN la cadena de consulta (ver
    // `InternalServiceGuard`): la peticion real va con `path` completo
    // (incluida `?afterSeq=...`), pero la firma se calcula solo sobre la
    // ruta, igual que hace cualquier llamador real.
    const signature = signInternalRequest(SECRET, {
      service,
      method: method.toUpperCase(),
      path: path.split('?')[0] ?? path,
      timestamp,
      body,
    })
    const builder =
      method === 'post'
        ? http()
            .post(path)
            .send(body as object)
        : http().get(path)

    return builder
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set('x-internal-signature', signature)
  }

  const createRoom = (body: Record<string, unknown> = CREATE_BODY()) =>
    signed('post', BASE_PATH, body)

  describe('POST /tournament-rooms', () => {
    it('rechaza llamadas sin firma o de un servicio no autorizado', async () => {
      expect((await http().post(BASE_PATH).send(CREATE_BODY())).status).toBe(401)
      expect((await signed('post', BASE_PATH, CREATE_BODY(), 'catalog')).status).toBe(401)
    })

    it('crea la sala con el roster fijo de 4, YA en PREPARING', async () => {
      const response = await createRoom()

      expect(response.status).toBe(201)
      expect(response.body.status).toBe('PREPARING')
      expect(response.body.mode).toBe('PVP')
      expect(response.body.teams[0]).toMatchObject({
        label: 'equipo1',
        participants: [
          { playerId: 'p1', heroId: 'heroe-de-p1' },
          { playerId: 'p2', heroId: 'heroe-de-p2' },
        ],
      })
      expect(response.body.createdBy).toBe('tournament:T1')
    })

    it('la sala creada NUNCA aparece en el listado publico de salas disponibles', async () => {
      const created = await createRoom(CREATE_BODY({ operationId: 'T1:E-listado' }))
      expect(created.status).toBe(201)

      const listed = await http().get(ROOMS_PATH).set('Authorization', auth('token-p1'))

      expect(listed.body.map((room: { id: string }) => room.id)).not.toContain(created.body.id)
    })

    it('es IDEMPOTENTE: el mismo operationId con el mismo cuerpo responde la MISMA sala', async () => {
      const body = CREATE_BODY({ operationId: 'T1:E-idem' })
      const first = await createRoom(body)
      const second = await createRoom(body)

      expect(second.status).toBe(201)
      expect(second.body.id).toBe(first.body.id)
    })

    it('el mismo operationId con un cuerpo DISTINTO responde 409', async () => {
      await createRoom(CREATE_BODY({ operationId: 'T1:E-conflicto' }))

      const changed = await createRoom({
        operationId: 'T1:E-conflicto',
        tournamentId: 'T1',
        encounterId: 'T1:E1',
        teams: [
          { teamId: 'equipo1', memberIds: ['p1', 'p9'] },
          { teamId: 'equipo2', memberIds: ['p3', 'p4'] },
        ],
      })

      expect(changed.status).toBe(409)
    })

    it('un cuerpo con otro numero de equipos es 400 (formato)', async () => {
      const response = await createRoom({ ...CREATE_BODY(), teams: [CREATE_BODY().teams] })

      expect(response.status).toBe(400)
      expect(response.body.code).toBe('SCHEMA_INVALID')
    })

    it('un equipo sin exactamente 2 jugadores es 422 (regla de negocio, "nunca hasta 4")', async () => {
      const response = await createRoom(
        CREATE_BODY({
          operationId: 'T1:E-roster-invalido',
          teams: [
            { teamId: 'equipo1', memberIds: ['p1'] },
            { teamId: 'equipo2', memberIds: ['p3', 'p4'] },
          ],
        }),
      )

      expect(response.status).toBe(422)
    })

    it('un jugador sin heroe equipado responde 422 con code HERO_NOT_SELECTED', async () => {
      heroDenylist.add('p3')

      const response = await createRoom(CREATE_BODY({ operationId: 'T1:E-sin-heroe' }))

      expect(response.status).toBe(422)
      expect(response.body.code).toBe('HERO_NOT_SELECTED')
    })
  })

  describe('aislamiento del lobby publico sobre una sala de torneo', () => {
    const tournamentRoomId = async (): Promise<string> => {
      const created = await createRoom(
        CREATE_BODY({ operationId: `T1:E-aislamiento-${String(Date.now())}` }),
      )

      return created.body.id as string
    }

    it('un jugador participante no puede abandonarla (409), aunque esta PREPARING', async () => {
      const roomId = await tournamentRoomId()

      const leave = await http()
        .post(`${ROOMS_PATH}/${roomId}/leave`)
        .set('Authorization', auth('token-p1'))

      expect(leave.status).toBe(409)
    })

    it('nadie puede unirse (409): la sala nunca esta WAITING_FOR_PLAYERS', async () => {
      const roomId = await tournamentRoomId()

      const join = await http()
        .post(`${ROOMS_PATH}/${roomId}/join`)
        .set('Authorization', auth('token-p2'))
        .send({})

      expect(join.status).toBe(409)
    })

    it('un participante no puede cancelarla (403): no es el creador sintetico', async () => {
      const roomId = await tournamentRoomId()

      const cancel = await http()
        .post(`${ROOMS_PATH}/${roomId}/cancel`)
        .set('Authorization', auth('token-p1'))

      expect(cancel.status).toBe(403)
    })

    it('un participante no puede iniciarla por la ruta publica (403): no es el creador', async () => {
      const roomId = await tournamentRoomId()

      const start = await http()
        .post(`${ROOMS_PATH}/${roomId}/start`)
        .set('Authorization', auth('token-p1'))

      expect(start.status).toBe(403)
    })
  })

  describe('POST /tournament-rooms/:roomId/start', () => {
    const START_BODY = { operationId: 'start-1', tournamentId: 'T1', encounterId: 'T1:E1' }

    it('reutiliza el motor real: arranca con una cola de 4 y compromete a los 4 heroes', async () => {
      const created = await createRoom(CREATE_BODY({ operationId: 'T1:E-start-ok' }))
      const roomId = created.body.id as string

      const started = await signed('post', `${BASE_PATH}/${roomId}/start`, START_BODY)

      expect(started.status).toBe(200)
      expect(started.body.status).toBe('IN_BATTLE')
      expect(started.body.battle.turnOrder).toHaveLength(4)
      expect(commitments.commits.map((c) => c.playerId).sort()).toEqual(['p1', 'p2', 'p3', 'p4'])
    })

    it('es IDEMPOTENTE: reenviarlo devuelve la misma sala, incluso tras FINISHED', async () => {
      const created = await createRoom(CREATE_BODY({ operationId: 'T1:E-start-idem' }))
      const roomId = created.body.id as string

      const first = await signed('post', `${BASE_PATH}/${roomId}/start`, START_BODY)
      const second = await signed('post', `${BASE_PATH}/${roomId}/start`, START_BODY)
      expect(second.body).toEqual(first.body)

      const repo = app.get<BattleRoomRepositoryPort>(BATTLE_ROOM_REPOSITORY)
      const room = await repo.findById(roomId)
      if (room === null) throw new Error('la sala debia existir')
      await repo.save(room.finish({ reason: 'TIME_LIMIT' }, new Date()), room.version)

      const afterFinish = await signed('post', `${BASE_PATH}/${roomId}/start`, START_BODY)
      expect(afterFinish.status).toBe(200)
      expect(afterFinish.body.status).toBe('FINISHED')
    })

    it('sala de lobby publico -> 404 (no es una sala de torneo)', async () => {
      const lobby = await http()
        .post(ROOMS_PATH)
        .set('Authorization', auth('token-p1'))
        .send({
          mode: 'PVP',
          teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
          reward: { amount: 0 },
        })

      const response = await signed(
        'post',
        `${BASE_PATH}/${lobby.body.id as string}/start`,
        START_BODY,
      )

      expect(response.status).toBe(404)
    })

    it('sala inexistente -> 404; roomId no UUID v4 -> 400', async () => {
      const unknown = '11111111-1111-4111-8111-111111111111'
      expect((await signed('post', `${BASE_PATH}/${unknown}/start`, START_BODY)).status).toBe(404)
      expect((await signed('post', `${BASE_PATH}/no-es-uuid/start`, START_BODY)).status).toBe(400)
    })
  })

  describe('GET /tournament-rooms/:roomId/record', () => {
    it('pagina el registro de eventos, funciona IN_BATTLE y despues de FINISHED', async () => {
      const created = await createRoom(CREATE_BODY({ operationId: 'T1:E-record' }))
      const roomId = created.body.id as string

      await signed('post', `${BASE_PATH}/${roomId}/start`, {
        operationId: 'start-record',
        tournamentId: 'T1',
        encounterId: 'T1:E1',
      })

      const afterStart = await signed('get', `${BASE_PATH}/${roomId}/record`)
      expect(afterStart.status).toBe(200)
      expect(afterStart.body.status).toBe('IN_BATTLE')
      expect(afterStart.body.startedAt).not.toBeNull()
      expect(afterStart.body.result).toBeNull()
      expect(afterStart.body.events.lastSeq).toBe(1)
      expect(afterStart.body.events.items).toHaveLength(1)
      expect(afterStart.body.events.items[0]).toMatchObject({ type: 'battleStarted', seq: 1 })
      expect(afterStart.body.teams[0].participants[0]).toMatchObject({
        playerId: 'p1',
        heroId: 'heroe-de-p1',
      })

      const pagedFromLast = await signed(
        'get',
        `${BASE_PATH}/${roomId}/record?afterSeq=${String(afterStart.body.events.lastSeq as number)}`,
      )
      expect(pagedFromLast.body.events.items).toHaveLength(0)

      const repo = app.get<BattleRoomRepositoryPort>(BATTLE_ROOM_REPOSITORY)
      const room = await repo.findById(roomId)
      if (room === null) throw new Error('la sala debia existir')
      await repo.save(
        room.finish({ reason: 'ELIMINATION', winnerTeamLabel: 'equipo1' }, new Date()),
        room.version,
      )

      const afterFinish = await signed('get', `${BASE_PATH}/${roomId}/record`)
      expect(afterFinish.status).toBe(200)
      expect(afterFinish.body.status).toBe('FINISHED')
      expect(afterFinish.body.result.winnerTeamLabel).toBe('equipo1')
      expect(afterFinish.body.events.items.at(-1)).toMatchObject({ type: 'battleFinished' })
    })

    it('afterSeq invalido -> 400; sala de lobby -> 404; sala inexistente -> 404', async () => {
      const created = await createRoom(CREATE_BODY({ operationId: 'T1:E-record-errores' }))
      const roomId = created.body.id as string

      expect((await signed('get', `${BASE_PATH}/${roomId}/record?afterSeq=-1`)).status).toBe(400)
      expect((await signed('get', `${BASE_PATH}/${roomId}/record?afterSeq=abc`)).status).toBe(400)

      const lobby = await http()
        .post(ROOMS_PATH)
        .set('Authorization', auth('token-p1'))
        .send({
          mode: 'PVP',
          teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
          reward: { amount: 0 },
        })
      expect((await signed('get', `${BASE_PATH}/${lobby.body.id as string}/record`)).status).toBe(
        404,
      )

      const unknown = '11111111-1111-4111-8111-111111111111'
      expect((await signed('get', `${BASE_PATH}/${unknown}/record`)).status).toBe(404)
    })

    it('solo responde a llamadas firmadas del servicio tournament', async () => {
      const created = await createRoom(CREATE_BODY({ operationId: 'T1:E-record-auth' }))
      const roomId = created.body.id as string

      expect((await http().get(`${BASE_PATH}/${roomId}/record`)).status).toBe(401)
      expect((await signed('get', `${BASE_PATH}/${roomId}/record`, {}, 'catalog')).status).toBe(401)
    })
  })
})
