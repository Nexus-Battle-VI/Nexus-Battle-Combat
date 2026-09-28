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
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import {
  BATTLE_ROOM_REPOSITORY,
  type BattleRoomRepositoryPort,
} from '../../src/application/ports/BattleRoomRepositoryPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { equippedHeroFixture, equippedProductNotOwnedBlocker } from '../fixtures/equipped-hero'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'

/**
 * HU-17 sobre HTTP (memoria): `POST /rooms/:id/start`, `GET /rooms/:id` y
 * `POST /realtime/tickets`. Ejercita el modulo completo (guards, controlador,
 * casos de uso, repositorio). El WebSocket real con MongoDB lo cubre
 * `test/db/battle-realtime.e2e.spec.ts`.
 */
const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-a': { subject: 'sujeto-a', email: null, roles: new Set([Role.Player]) },
  'token-b': { subject: 'sujeto-b', email: null, roles: new Set([Role.Player]) },
  'token-c': { subject: 'sujeto-c', email: null, roles: new Set([Role.Player]) },
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

/** Heroes: por defecto listos; `notReady` los marca no elegibles DESPUES de unirse. */
const heroState = { notReady: new Set<string>(), loadoutVersion: new Map<string, number>() }

const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(
      heroState.notReady.has(playerId)
        ? equippedHeroFixture({
            playerId,
            heroId: `heroe-de-${playerId}`,
            ready: false,
            blockers: [equippedProductNotOwnedBlocker],
            loadoutVersion: heroState.loadoutVersion.get(playerId) ?? 0,
          })
        : equippedHeroFixture({
            playerId,
            heroId: `heroe-de-${playerId}`,
            loadoutVersion: heroState.loadoutVersion.get(playerId) ?? 0,
          }),
    ),
}

/**
 * HU-29: el compromiso de equipamiento es una llamada saliente a
 * Player/Inventory. Aqui se sustituye por un doble que REGISTRA, igual que el
 * heroe equipado: lo que se prueba en esta suite es el cableado del modulo, no
 * el cliente HTTP (que tiene su propia prueba unitaria).
 */
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

/** El creador ya ocupa el equipo A: el siguiente join completa la sala (PREPARING). */
const roomWithOneSlotLeft = () => ({
  mode: 'PVP',
  teamConfigs: [{ capacity: 1, initialParticipants: [{ kind: 'HUMAN' }] }, { capacity: 1 }],
  reward: { amount: 0 },
})

const UNKNOWN_ROOM = '11111111-1111-4111-8111-111111111111'

describe('HU-17 sobre HTTP: iniciar batalla, leer sala y ticket del WebSocket', () => {
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
    heroState.notReady.clear()
    heroState.loadoutVersion.clear()
    commitments.commits.length = 0
    commitments.releases.length = 0
    commitments.failCommits = false
    commitments.failReleases = false
  })

  const http = () => request(app.getHttpServer())
  const auth = (token: string) => `Bearer ${token}`

  /**
   * HU-21: cierra la sala en curso por vencimiento global, escribiendo por el
   * repositorio real del modulo (sin atajos). El resultado queda persistido y la
   * sala pasa a FINISHED, que es lo que comprueban las rutas HTTP.
   */
  const finishRoom = async (roomId: string): Promise<void> => {
    const repo = app.get<BattleRoomRepositoryPort>(BATTLE_ROOM_REPOSITORY)
    const room = await repo.findById(roomId)

    if (room === null) {
      throw new Error('la sala debia existir')
    }

    const finished = room.finish({ reason: 'TIME_LIMIT' }, new Date())

    await repo.save(finished, room.version)
  }

  /** Crea una sala con `token-a` y une a `token-b`: queda PREPARING. */
  const preparingRoom = async (): Promise<string> => {
    const created = await http()
      .post('/api/v1/combat/rooms')
      .set('Authorization', auth('token-a'))
      .send(roomWithOneSlotLeft())

    expect(created.status).toBe(201)

    const joined = await http()
      .post(`/api/v1/combat/rooms/${created.body.id as string}/join`)
      .set('Authorization', auth('token-b'))
      .send({})

    expect(joined.status).toBe(200)
    expect(joined.body.status).toBe('PREPARING')

    return created.body.id as string
  }

  describe('POST /rooms/:id/start', () => {
    it('equipos de distinto tamano (1 contra 3): 422 con code UNSUPPORTED_TEAM_COMPOSITION y la sala sigue PREPARING', async () => {
      const created = await http()
        .post('/api/v1/combat/rooms')
        .set('Authorization', auth('token-a'))
        .send({
          mode: 'PVE',
          teamConfigs: [
            { capacity: 1, initialParticipants: [{ kind: 'HUMAN' }] },
            {
              capacity: 3,
              initialParticipants: [
                { kind: 'AI', heroId: 'ai-0' },
                { kind: 'AI', heroId: 'ai-1' },
              ],
            },
          ],
          reward: { amount: 0 },
        })

      expect(created.status).toBe(201)

      const roomId = created.body.id as string
      const joined = await http()
        .post(`/api/v1/combat/rooms/${roomId}/join`)
        .set('Authorization', auth('token-b'))
        .send({})

      expect(joined.body.status).toBe('PREPARING')

      const started = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      expect(started.status).toBe(422)
      expect(started.body.code).toBe('UNSUPPORTED_TEAM_COMPOSITION')
      expect(started.body.message).toContain('1 contra 3')

      const read = await http()
        .get(`/api/v1/combat/rooms/${roomId}`)
        .set('Authorization', auth('token-a'))

      expect(read.body.status).toBe('PREPARING')
      expect(read.body.battle).toBeNull()
      expect(read.body.lastSeq).toBe(0)
    })

    it('sala preparada: el propietario inicia la batalla con UNA cola de dos participantes y responde la sala en curso', async () => {
      const roomId = await preparingRoom()

      const started = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      expect(started.status).toBe(200)
      expect(started.body.status).toBe('IN_BATTLE')
      expect(started.body.lastSeq).toBe(1)
      expect(started.body.battle.battleId).toBe(roomId)
      expect(started.body.battle.turnOrder).toHaveLength(2)
      expect(started.body.battle.turnsCompleted).toBe(0)
      expect(started.body.battle.currentTurn.position).toBe(0)
      expect(
        new Set(started.body.battle.turnOrder.map((entry: { playerId: string }) => entry.playerId)),
      ).toEqual(new Set(['sujeto-a', 'sujeto-b']))
    })

    it('HU-29: iniciar por HTTP compromete el heroe equipado de CADA humano de la sala', async () => {
      const roomId = await preparingRoom()

      const started = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      expect(started.status).toBe(200)
      expect(commitments.commits.map(({ playerId }) => playerId).sort()).toEqual([
        'sujeto-a',
        'sujeto-b',
      ])
      expect(commitments.commits.map(({ heroId }) => heroId).sort()).toEqual([
        'heroe-de-sujeto-a',
        'heroe-de-sujeto-b',
      ])
      expect(new Set(commitments.commits.map(({ roomId: reference }) => reference))).toEqual(
        new Set([roomId]),
      )
      expect(commitments.commits[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('el equipo inicial lo decide el motor HU-24 (secuencia de proceso con la semilla validada), no el cliente', async () => {
      const roomId = await preparingRoom()

      const started = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      // La secuencia de proceso es compartida entre los tests de este archivo: solo se exige que
      // el resultado sea un equipo de la sala. El valor exacto (primer indice 2648 -> equipo B con la
      // semilla 3.000.000) lo fija el test unitario con la fuente real (`start-battle.spec.ts`).
      expect(['A', 'B']).toContain(started.body.battle.currentTurn.teamLabel)
    })

    it('el cuerpo se IGNORA: enviar equipo inicial u orden no cambia nada (ningun cliente elige)', async () => {
      const roomId = await preparingRoom()

      const started = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))
        .send({ startingTeam: 'A', turnOrder: ['sujeto-a', 'sujeto-b'] })

      // El controlador no declara cuerpo: NADA de lo enviado se usa.
      expect(started.status).toBe(200)

      const read = await http()
        .get(`/api/v1/combat/rooms/${roomId}`)
        .set('Authorization', auth('token-a'))

      expect(read.body.battle).toEqual(started.body.battle)
      expect(read.body.battle.turnOrder).toHaveLength(2)
    })

    it('es IDEMPOTENTE: iniciar otra vez (o desde el otro participante) devuelve la MISMA cola y el mismo seq', async () => {
      const roomId = await preparingRoom()
      const first = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))
      const second = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-b'))

      expect(second.status).toBe(200)
      expect(second.body).toEqual(first.body)
      expect(second.body.lastSeq).toBe(1)
    })

    it('dos inicios SIMULTANEOS del propietario producen una sola cola y un solo battleStarted', async () => {
      const roomId = await preparingRoom()

      const [a, b] = await Promise.all([
        http().post(`/api/v1/combat/rooms/${roomId}/start`).set('Authorization', auth('token-a')),
        http().post(`/api/v1/combat/rooms/${roomId}/start`).set('Authorization', auth('token-a')),
      ])

      expect([a.status, b.status]).toEqual([200, 200])
      expect(a.body.battle.turnOrder).toEqual(b.body.battle.turnOrder)
      expect(a.body.lastSeq).toBe(1)
      expect(b.body.lastSeq).toBe(1)
    })

    it('HU-21: iniciar una sala FINISHED responde el conflicto de estado ya existente (409)', async () => {
      const roomId = await preparingRoom()

      await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))
      await finishRoom(roomId)

      const again = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      expect(again.status).toBe(409)

      const read = await http()
        .get(`/api/v1/combat/rooms/${roomId}`)
        .set('Authorization', auth('token-a'))

      expect(read.body.status).toBe('FINISHED')
      expect(read.body.lastSeq).toBe(2)
    })

    it('un participante que ya no es elegible bloquea el inicio: 422 con blockers, sin cola', async () => {
      const roomId = await preparingRoom()

      heroState.notReady.add('sujeto-b')

      const blocked = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      expect(blocked.status).toBe(422)
      expect(blocked.body.blockers).toEqual([equippedProductNotOwnedBlocker])

      const read = await http()
        .get(`/api/v1/combat/rooms/${roomId}`)
        .set('Authorization', auth('token-a'))

      expect(read.body.status).toBe('PREPARING')
      expect(read.body.battle).toBeNull()
      expect(read.body.lastSeq).toBe(0)
    })

    it('el equipamiento cambio despues de unirse (version de loadout): 422 HERO_LOADOUT_CHANGED', async () => {
      const roomId = await preparingRoom()

      heroState.loadoutVersion.set('sujeto-b', 9)

      const blocked = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      expect(blocked.status).toBe(422)
      expect(blocked.body.blockers.map((blocker: { code: string }) => blocker.code)).toContain(
        'HERO_LOADOUT_CHANGED',
      )
    })

    it('un no participante NO puede iniciar (403) y no se crea nada', async () => {
      const roomId = await preparingRoom()

      const forbidden = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-c'))

      expect(forbidden.status).toBe(403)

      const read = await http()
        .get(`/api/v1/combat/rooms/${roomId}`)
        .set('Authorization', auth('token-a'))

      expect(read.body.status).toBe('PREPARING')
    })

    it('un participante que NO es el propietario NO puede iniciar (403) y no se crea nada', async () => {
      const roomId = await preparingRoom()

      const forbidden = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-b'))

      expect(forbidden.status).toBe(403)

      const read = await http()
        .get(`/api/v1/combat/rooms/${roomId}`)
        .set('Authorization', auth('token-a'))

      expect(read.body.status).toBe('PREPARING')
      expect(read.body.battle).toBeNull()
    })

    it('una sala que todavia espera jugadores no inicia: 409', async () => {
      const created = await http()
        .post('/api/v1/combat/rooms')
        .set('Authorization', auth('token-a'))
        .send(roomWithOneSlotLeft())

      const response = await http()
        .post(`/api/v1/combat/rooms/${created.body.id as string}/start`)
        .set('Authorization', auth('token-a'))

      expect(response.status).toBe(409)
    })

    it('sala inexistente 404; roomId no UUID v4 400; sin testimonio 401', async () => {
      expect(
        (
          await http()
            .post(`/api/v1/combat/rooms/${UNKNOWN_ROOM}/start`)
            .set('Authorization', auth('token-a'))
        ).status,
      ).toBe(404)
      expect(
        (
          await http()
            .post('/api/v1/combat/rooms/no-es-uuid/start')
            .set('Authorization', auth('token-a'))
        ).status,
      ).toBe(400)
      expect((await http().post(`/api/v1/combat/rooms/${UNKNOWN_ROOM}/start`)).status).toBe(401)
    })

    it('tras iniciar, la sala en batalla ya no admite abandonar ni cancelar (la lista es definitiva): 409', async () => {
      const roomId = await preparingRoom()

      await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      const leave = await http()
        .post(`/api/v1/combat/rooms/${roomId}/leave`)
        .set('Authorization', auth('token-b'))
      const cancel = await http()
        .post(`/api/v1/combat/rooms/${roomId}/cancel`)
        .set('Authorization', auth('token-a'))

      expect(leave.status).toBe(409)
      expect(cancel.status).toBe(409)
    })
  })

  describe('GET /rooms/:id', () => {
    it('devuelve la sala con su batalla a un participante', async () => {
      const roomId = await preparingRoom()

      await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      const read = await http()
        .get(`/api/v1/combat/rooms/${roomId}`)
        .set('Authorization', auth('token-b'))

      expect(read.status).toBe(200)
      expect(read.body.status).toBe('IN_BATTLE')
      expect(read.body.battle.turnOrder).toHaveLength(2)
    })

    it('HU-21: una sala FINISHED trae el `result` y su vista final sin `deadlines`', async () => {
      const roomId = await preparingRoom()

      await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))
      await finishRoom(roomId)

      const read = await http()
        .get(`/api/v1/combat/rooms/${roomId}`)
        .set('Authorization', auth('token-b'))

      expect(read.status).toBe(200)
      expect(read.body.status).toBe('FINISHED')
      expect(read.body.result).toMatchObject({
        reason: 'TIME_LIMIT',
        outcome: 'NO_WINNER',
        winnerTeamLabel: null,
        tiebreak: null,
        disconnected: null,
      })
      expect(read.body.result.participants.map((p: { result: string }) => p.result)).toEqual([
        'NO_WINNER',
        'NO_WINNER',
      ])
      expect(read.body.battle).not.toHaveProperty('deadlines')
    })

    it('HU-21: en una sala en curso `result` es null', async () => {
      const roomId = await preparingRoom()

      await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      const read = await http()
        .get(`/api/v1/combat/rooms/${roomId}`)
        .set('Authorization', auth('token-b'))

      expect(read.body.result).toBeNull()
    })

    it('la respuesta no contiene semilla, estado del generador ni datos internos', async () => {
      const roomId = await preparingRoom()
      const started = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth('token-a'))

      expect(JSON.stringify(started.body)).not.toMatch(/seed|semilla|mt19937|draw|jwt|ticket/i)
    })

    it('un no participante recibe 403; sala inexistente 404; sin testimonio 401', async () => {
      const roomId = await preparingRoom()

      expect(
        (await http().get(`/api/v1/combat/rooms/${roomId}`).set('Authorization', auth('token-c')))
          .status,
      ).toBe(403)
      expect(
        (
          await http()
            .get(`/api/v1/combat/rooms/${UNKNOWN_ROOM}`)
            .set('Authorization', auth('token-a'))
        ).status,
      ).toBe(404)
      expect((await http().get(`/api/v1/combat/rooms/${roomId}`)).status).toBe(401)
    })

    it('GET /rooms sigue listando solo salas esperando: HU-14/15 no se rompen', async () => {
      const created = await http()
        .post('/api/v1/combat/rooms')
        .set('Authorization', auth('token-a'))
        .send(roomWithOneSlotLeft())
      const list = await http().get('/api/v1/combat/rooms').set('Authorization', auth('token-c'))

      expect(list.status).toBe(200)
      expect(list.body.map((room: { id: string }) => room.id)).toContain(created.body.id)
      expect(
        list.body.every((room: { status: string }) => room.status === 'WAITING_FOR_PLAYERS'),
      ).toBe(true)
    })
  })

  describe('POST /realtime/tickets (ADR-020)', () => {
    it('con testimonio valido emite un ticket opaco de 30 s', async () => {
      const response = await http()
        .post('/api/v1/combat/realtime/tickets')
        .set('Authorization', auth('token-a'))

      expect(response.status).toBe(201)
      expect(response.body.expiresInSeconds).toBe(30)
      expect(typeof response.body.ticket).toBe('string')
      expect((response.body.ticket as string).length).toBeGreaterThanOrEqual(43)
      expect(Object.keys(response.body).sort()).toEqual(['expiresInSeconds', 'ticket'])
    })

    it('cada peticion emite un ticket distinto', async () => {
      const first = await http()
        .post('/api/v1/combat/realtime/tickets')
        .set('Authorization', auth('token-a'))
      const second = await http()
        .post('/api/v1/combat/realtime/tickets')
        .set('Authorization', auth('token-a'))

      expect(first.body.ticket).not.toBe(second.body.ticket)
    })

    it('sin testimonio o con uno invalido responde 401', async () => {
      expect((await http().post('/api/v1/combat/realtime/tickets')).status).toBe(401)
      expect(
        (
          await http()
            .post('/api/v1/combat/realtime/tickets')
            .set('Authorization', 'Bearer invalido')
        ).status,
      ).toBe(401)
    })

    it('no acepta un playerId ni un sub en el cuerpo: el ticket es del sub verificado', async () => {
      const response = await http()
        .post('/api/v1/combat/realtime/tickets')
        .set('Authorization', auth('token-a'))
        .send({ playerId: 'sujeto-b' })

      expect(response.status).toBe(201)
      expect(Object.keys(response.body as object)).not.toContain('playerId')
    })
  })
})
