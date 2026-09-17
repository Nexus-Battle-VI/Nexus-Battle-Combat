import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Contrato HTTP de HU-14 (`POST /rooms`, `GET /rooms`,
 * `POST /rooms/{id}/cancel`) sobre `PERSISTENCE_DRIVER=memory`: ejercita el
 * modulo completo (guards, DTOs, controlador, casos de uso, repositorio en
 * memoria) sin necesitar MongoDB. La persistencia real contra Mongo la
 * cubre `test/db/mongo-battle-room-repository.spec.ts`.
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

const validRoom = () => ({
  mode: 'PVP',
  teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
  reward: { amount: 0 },
})

/** UUID v4 bien formado que no corresponde a ninguna sala creada. */
const NONEXISTENT_ROOM_ID = '11111111-1111-4111-8111-111111111111'

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('POST/GET/cancel /api/v1/combat/rooms', () => {
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
      .compile()

    app = moduleRef.createNestApplication()
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

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`)

  describe('POST /rooms', () => {
    it('responde 401 sin testimonio', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/combat/rooms')
        .send(validRoom())

      expect(response.status).toBe(401)
    })

    it('crea la sala y responde 201 con createdBy tomado del JWT', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(validRoom()),
      )

      expect(response.status).toBe(201)
      expect(response.body).toMatchObject({
        status: 'WAITING_FOR_PLAYERS',
        createdBy: 'sujeto-creador',
        version: 1,
      })
      // UUID v4 estricto (digito de version `4` y variante `8|9|a|b`), no
      // cualquier cadena de 36 caracteres con guiones: HU-14.1 fija UUID v4
      // para `BattleRoomId`, y `UuidGenerator` (node:crypto randomUUID())
      // siempre produce v4, asi que el formato real debe poder verificarse.
      expect(response.body.id).toMatch(UUID_V4_PATTERN)
    })

    it('422 cuando la composicion PVP/AI es invalida (InvalidModeCompositionError vía HTTP)', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer())
          .post('/api/v1/combat/rooms')
          .send({
            ...validRoom(),
            teamConfigs: [{ capacity: 1, initialParticipants: [{ kind: 'AI' }] }, { capacity: 1 }],
          }),
      )

      expect(response.status).toBe(422)
    })

    it('rechaza un cuerpo que intenta declarar createdBy (whitelist -> 400, nunca lo usa)', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer())
          .post('/api/v1/combat/rooms')
          .send({ ...validRoom(), createdBy: 'alguien-mas' }),
      )

      expect(response.status).toBe(400)
    })

    it('400 con cuerpo malformado (modo desconocido)', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer())
          .post('/api/v1/combat/rooms')
          .send({ ...validRoom(), mode: 'INVALIDA' }),
      )

      expect(response.status).toBe(400)
    })

    it('422 cuando la capacidad de un equipo esta fuera de 1..3', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer())
          .post('/api/v1/combat/rooms')
          .send({ ...validRoom(), teamConfigs: [{ capacity: 4 }, { capacity: 1 }] }),
      )

      expect(response.status).toBe(422)
    })

    it('422 cuando la recompensa es negativa', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer())
          .post('/api/v1/combat/rooms')
          .send({ ...validRoom(), reward: { amount: -5 } }),
      )

      expect(response.status).toBe(422)
    })

    it('400 cuando el cuerpo trae un campo no declarado (whitelist)', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer())
          .post('/api/v1/combat/rooms')
          .send({ ...validRoom(), campoInventado: true }),
      )

      expect(response.status).toBe(400)
    })
  })

  describe('GET /rooms', () => {
    it('responde 401 sin testimonio', async () => {
      expect((await request(app.getHttpServer()).get('/api/v1/combat/rooms')).status).toBe(401)
    })

    it('lista solo salas disponibles', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(validRoom()),
      )

      const response = await authed('token-creador')(
        request(app.getHttpServer()).get('/api/v1/combat/rooms'),
      )

      expect(response.status).toBe(200)
      expect((response.body as { id: string }[]).some((room) => room.id === created.body.id)).toBe(
        true,
      )
    })
  })

  describe('POST /rooms/:roomId/cancel', () => {
    it('responde 401 sin testimonio', async () => {
      const response = await request(app.getHttpServer()).post(
        '/api/v1/combat/rooms/cualquiera/cancel',
      )

      expect(response.status).toBe(401)
    })

    it('404 si la sala no existe (UUID v4 bien formado, sin sala asociada)', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${NONEXISTENT_ROOM_ID}/cancel`),
      )

      expect(response.status).toBe(404)
    })

    it('400 si roomId no es un UUID v4 valido (no se confunde con 404)', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms/no-es-un-uuid/cancel'),
      )

      expect(response.status).toBe(400)
    })

    it('el creador cancela: 200 y status CANCELLED', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(validRoom()),
      )

      const response = await authed('token-creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/cancel`),
      )

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ status: 'CANCELLED' })
    })

    it('403 si quien pide no es el creador', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(validRoom()),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/cancel`),
      )

      expect(response.status).toBe(403)
    })

    it('409 si la sala ya no es cancelable', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(validRoom()),
      )

      await authed('token-creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/cancel`),
      )

      const response = await authed('token-creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/cancel`),
      )

      expect(response.status).toBe(409)
    })

    /**
     * Conflicto de bloqueo optimista a traves de la capa HTTP completa (no
     * solo del repositorio o del caso de uso aislados): dos cancelaciones
     * concurrentes de la MISMA sala deben resolver en un 200 y un 409, nunca
     * en dos 200 ni en un error no mapeado.
     */
    it('409 en una de dos cancelaciones concurrentes de la misma sala (conflicto optimista real vía HTTP)', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(validRoom()),
      )
      const path = `/api/v1/combat/rooms/${String(created.body.id)}/cancel`

      const [first, second] = await Promise.all([
        authed('token-creador')(request(app.getHttpServer()).post(path)),
        authed('token-creador')(request(app.getHttpServer()).post(path)),
      ])

      const statuses = [first.status, second.status].sort((a, b) => a - b)
      expect(statuses).toEqual([200, 409])
    })
  })
})
