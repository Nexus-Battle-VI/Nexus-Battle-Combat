import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import {
  ACCOUNT_BATTLE_PROFILE,
  type AccountBattleProfilePort,
} from '../../src/application/ports/AccountBattleProfilePort'
import {
  AccountProfileMissingError,
  UpstreamServiceError,
} from '../../src/application/errors/UpstreamErrors'
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
  // HU-15.4: testimonio valido (firma/JWT correctos) para un sujeto SIN
  // cuenta en Account -- el escenario real que motivo esta suite de
  // regresion (ver `AccountProfileMissingError`).
  'token-sin-cuenta': { subject: 'sujeto-sin-cuenta', email: null, roles: new Set([Role.Player]) },
  'token-account-caido': {
    subject: 'sujeto-account-caido',
    email: null,
    roles: new Set([Role.Player]),
  },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

/**
 * HU-15.2 (fase de integracion cross-service): `JoinBattleRoom` ahora
 * depende de Account y Player-Inventory. Esta suite ejercita el contrato
 * HTTP de Combat, no la integracion HTTP saliente en si (que tiene su propia
 * suite dedicada con `fetchImpl` inyectado, ver
 * `test/unit/internal-http-clients.spec.ts`), asi que se reemplazan los dos
 * puertos con dobles deterministas -- mismo criterio que `stubVerifier`
 * arriba con `TOKEN_VERIFIER`. El nombre se deriva del `subject` para que
 * cada identidad de `IDENTITIES` tenga un `displayName` distinto y no choque
 * con la nueva unicidad de nombre del dominio.
 */
/**
 * HU-15.4: dos sujetos reservados hacen que el doble reproduzca, sin tocar
 * Account real, las dos condiciones que HU-15.2 colapsaba erroneamente en
 * el mismo 503 (`UpstreamServiceError`) antes de esta correccion --
 * `sujeto-sin-cuenta` (Account respondio 404: informacion de negocio,
 * `AccountProfileMissingError`, 422) y `sujeto-account-caido` (Account no
 * respondio de verdad, `UpstreamServiceError`, 503 -- sigue siendo el
 * comportamiento correcto para una caida real). Cualquier otro sujeto sigue
 * resolviendo con exito, igual que antes.
 */
const stubAccountProfiles: AccountBattleProfilePort = {
  getBattleProfile: (subject) => {
    if (subject === 'sujeto-sin-cuenta') {
      return Promise.reject(new AccountProfileMissingError(subject))
    }

    if (subject === 'sujeto-account-caido') {
      return Promise.reject(new UpstreamServiceError('account', 'no_alcanzable'))
    }

    return Promise.resolve({ subject, displayName: `nombre-de-${subject}`, avatarUrl: null })
  },
}

const stubEquippedHeroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) => Promise.resolve({ playerId, heroId: `heroe-de-${playerId}` }),
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

/** Sala con cupo de sobra (2 por equipo): un join no la completa. */
const roomWithSpareCapacity = () => ({
  mode: 'PVP',
  teamConfigs: [{ capacity: 2 }, { capacity: 2 }],
  reward: { amount: 0 },
})

/**
 * Sala con el creador ya ocupando el equipo A (capacidad 1, completo) y un
 * unico cupo restante en el equipo B: el PROXIMO join agota el cupo TOTAL de
 * la sala. `initialParticipants: [{kind: 'HUMAN'}]` se resuelve al creador
 * (mismo mecanismo que HU-14: `CreateBattleRoom` resuelve `playerId =
 * createdBy` para todo HUMAN declarado sin playerId explicito).
 */
const roomWithOneSlotLeft = () => ({
  mode: 'PVP',
  teamConfigs: [{ capacity: 1, initialParticipants: [{ kind: 'HUMAN' }] }, { capacity: 1 }],
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
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(stubAccountProfiles)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(stubEquippedHeroes)
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

  describe('POST /rooms/:roomId/join (HU-15.2, RF-15)', () => {
    it('400 si roomId no es un UUID v4 valido', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms/no-es-un-uuid/join'),
      )

      expect(response.status).toBe(400)
    })

    it('401 sin testimonio', async () => {
      const response = await request(app.getHttpServer()).post(
        `/api/v1/combat/rooms/${NONEXISTENT_ROOM_ID}/join`,
      )

      expect(response.status).toBe(401)
    })

    it('404 si la sala no existe', async () => {
      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${NONEXISTENT_ROOM_ID}/join`),
      )

      expect(response.status).toBe(404)
    })

    it('422 (no 503) cuando Account responde 404 porque el sujeto verificado no tiene cuenta todavia (HU-15.4)', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithSpareCapacity()),
      )

      const response = await authed('token-sin-cuenta')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/join`),
      )

      expect(response.status).toBe(422)
      expect(response.body.code).toBe('ACCOUNT_PROFILE_NOT_FOUND')
      expect(String(response.body.message)).not.toMatch(/no est.{1,2} disponible/i)
    })

    it('503 (no 422) cuando Account realmente no responde (no alcanzable), distinto del 422 de sujeto sin cuenta (HU-15.4)', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithSpareCapacity()),
      )

      const response = await authed('token-account-caido')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/join`),
      )

      expect(response.status).toBe(503)
    })

    it('409 si la sala esta CANCELLED', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(validRoom()),
      )
      await authed('token-creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/cancel`),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/join`),
      )

      expect(response.status).toBe(409)
    })

    it('409 si la sala esta PREPARING (ya completo su cupo)', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithOneSlotLeft()),
      )
      const filled = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/join`),
      )
      expect(filled.status).toBe(200)
      expect(filled.body.status).toBe('PREPARING')

      const response = await authed('token-creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/join`),
      )

      expect(response.status).toBe(409)
    })

    it('409 si el equipo solicitado esta lleno', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithOneSlotLeft()),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer())
          .post(`/api/v1/combat/rooms/${String(created.body.id)}/join`)
          .send({ team: 'A' }),
      )

      expect(response.status).toBe(409)
    })

    it('409 si el jugador ya es participante de la sala (segundo intento del mismo subject)', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithSpareCapacity()),
      )
      await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/join`),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/join`),
      )

      expect(response.status).toBe(409)
    })

    it('200: ingreso normal deja la sala en WAITING_FOR_PLAYERS cuando sobra cupo', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithSpareCapacity()),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/join`),
      )

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ status: 'WAITING_FOR_PLAYERS' })
      const allParticipants = (
        response.body.teams as { participants: { playerId: string | null }[] }[]
      ).flatMap((team) => team.participants)
      expect(allParticipants.some((participant) => participant.playerId === 'sujeto-otro')).toBe(
        true,
      )
    })

    it('200: ingreso con team explicito valido asigna al equipo solicitado', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithSpareCapacity()),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer())
          .post(`/api/v1/combat/rooms/${String(created.body.id)}/join`)
          .send({ team: 'B' }),
      )

      expect(response.status).toBe(200)
      expect(
        (response.body.teams as { label: string; participants: { playerId: string | null }[] }[])
          .find((team) => team.label === 'B')
          ?.participants.some((participant) => participant.playerId === 'sujeto-otro'),
      ).toBe(true)
    })

    it('200: el join que ocupa el ultimo cupo total responde con status PREPARING', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithOneSlotLeft()),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${String(created.body.id)}/join`),
      )

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('PREPARING')
    })

    it('400 si el cuerpo trae un campo no declarado (whitelist), ej. playerId', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithSpareCapacity()),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer())
          .post(`/api/v1/combat/rooms/${String(created.body.id)}/join`)
          .send({ playerId: 'alguien-mas' }),
      )

      expect(response.status).toBe(400)
    })

    it('400 si team no es una etiqueta valida (ni A ni B)', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithSpareCapacity()),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer())
          .post(`/api/v1/combat/rooms/${String(created.body.id)}/join`)
          .send({ team: 'Z' }),
      )

      expect(response.status).toBe(400)
    })

    /**
     * Concurrencia sobre el ultimo cupo a traves de la capa HTTP completa:
     * dos jugadores distintos intentan unirse a la vez a una sala con un solo
     * cupo restante. Exactamente uno debe prosperar (200, PREPARING); el otro
     * debe recibir 409 (RoomFullError o RoomConflictError segun el orden real
     * de ejecucion), nunca overbooking ni dos 200.
     */
    it('409 en uno de dos joins concurrentes disputando el mismo ultimo cupo', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithOneSlotLeft()),
      )
      const path = `/api/v1/combat/rooms/${String(created.body.id)}/join`

      // Dos jugadores DISTINTOS del creador, ninguno participante previo:
      // ambos compiten por el UNICO cupo restante (RoomFullError si su
      // escritura pierde antes, o RoomConflictError si pierde despues, segun
      // el orden real de ejecucion). Nunca overbooking, nunca dos 200.
      const [first, second] = await Promise.all([
        authed('token-otro')(request(app.getHttpServer()).post(path)),
        authed('token-otro')(request(app.getHttpServer()).post(path)),
      ])

      const statuses = [first.status, second.status].sort((a, b) => a - b)
      expect(statuses).toEqual([200, 409])
    })
  })

  describe('POST /rooms/:roomId/leave (ciclo de vida del lobby)', () => {
    it('400 si roomId no es un UUID v4 valido', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms/no-es-un-uuid/leave'),
      )

      expect(response.status).toBe(400)
    })

    it('401 sin testimonio', async () => {
      const response = await request(app.getHttpServer()).post(
        `/api/v1/combat/rooms/${NONEXISTENT_ROOM_ID}/leave`,
      )

      expect(response.status).toBe(401)
    })

    it('404 si la sala no existe', async () => {
      const response = await authed('token-creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${NONEXISTENT_ROOM_ID}/leave`),
      )

      expect(response.status).toBe(404)
    })

    it('un participante abandona: 200, cupo liberado, status vuelve a WAITING_FOR_PLAYERS', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithSpareCapacity()),
      )
      const roomId = String(created.body.id)
      await authed('token-otro')(
        request(app.getHttpServer())
          .post(`/api/v1/combat/rooms/${roomId}/join`)
          .send({ team: 'A' }),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/leave`),
      )

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ status: 'WAITING_FOR_PLAYERS' })
      const teams = response.body.teams as { participants: unknown[] }[]
      expect(teams.some((team) => team.participants.length > 0)).toBe(false)
    })

    it('abandonar libera el ultimo cupo -> PREPARING vuelve a WAITING_FOR_PLAYERS', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithOneSlotLeft()),
      )
      const roomId = String(created.body.id)
      const joined = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/join`),
      )
      expect(joined.body.status).toBe('PREPARING')

      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/leave`),
      )

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ status: 'WAITING_FOR_PLAYERS' })
    })

    it('el propietario tambien puede abandonar como participante', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithOneSlotLeft()),
      )
      const roomId = String(created.body.id)

      const response = await authed('token-creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/leave`),
      )

      expect(response.status).toBe(200)
      const teams = response.body.teams as { participants: unknown[] }[]
      expect(teams.some((team) => team.participants.length > 0)).toBe(false)
    })

    it('409 si quien pide no es participante de la sala', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(validRoom()),
      )
      const roomId = String(created.body.id)

      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/leave`),
      )

      expect(response.status).toBe(409)
    })

    it('409 si la sala ya esta CANCELLED', async () => {
      const created = await authed('token-creador')(
        request(app.getHttpServer()).post('/api/v1/combat/rooms').send(roomWithSpareCapacity()),
      )
      const roomId = String(created.body.id)
      await authed('token-otro')(
        request(app.getHttpServer())
          .post(`/api/v1/combat/rooms/${roomId}/join`)
          .send({ team: 'A' }),
      )
      await authed('token-creador')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/cancel`),
      )

      const response = await authed('token-otro')(
        request(app.getHttpServer()).post(`/api/v1/combat/rooms/${roomId}/leave`),
      )

      expect(response.status).toBe(409)
    })
  })
})
