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
import { BATTLE_DROP_INVENTORY } from '../../src/application/ports/BattleDropInventoryPort'
import {
  BOT_COMBAT_CATALOG,
  type BotCombatCatalogPort,
} from '../../src/application/ports/BotCombatCatalogPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { BasicAttackRealtimeHandler } from '../../src/adapters/inbound/ws/BasicAttackRealtimeHandler'
import { equippedHeroFixture } from '../fixtures/equipped-hero'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'
import { recordingBattleDropInventory } from '../fixtures/battle-drop-inventory'
import { botCatalogCandidates, offensiveHero } from '../fixtures/combat-bot-candidates'
import { FakeSocket } from '../fixtures/fake-socket'

/**
 * HU-93.3 (Management#559): ciclo COMPLETO de una justa JcE 1v1 Humano vs IA
 * contra el modulo Nest real (DI completa, memoria), desde `/start` hasta
 * `FINISHED`, verificando que la IA nunca se vuelve una entidad economica
 * mientras el humano conserva su recompensa normal. Las piezas sueltas ya
 * estan probadas a fondo (unit): esto es la prueba de que, cableadas juntas,
 * de verdad producen el resultado esperado.
 *
 * El catalogo del bot tiene UN heroe ofensivo con Vida/Defensa minimas: el
 * primer ataque del humano -- cualquiera que sea el dado real -- siempre
 * resulta letal, sin tener que guionizar el RNG de combate.
 */
const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-a': { subject: 'sujeto-a', email: null, roles: new Set([Role.Player]) },
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

const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) =>
    Promise.resolve(equippedHeroFixture({ playerId, heroId: `heroe-de-${playerId}` })),
}

const catalog: BotCombatCatalogPort = {
  listBotCandidates: () =>
    Promise.resolve(
      botCatalogCandidates({ heroes: [offensiveHero({ baseHealth: 1, baseDefense: 0 })] }),
    ),
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

interface RewardStatusBody {
  readonly creditsEarned: number | null
  readonly rewardDelivery: string
}

const waitUntil = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read()

    if (done(value)) return value

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error('la condicion esperada nunca se cumplio')
}

describe('HU-93.3 sobre HTTP: la IA nunca es una entidad economica (Management#559)', () => {
  let app: INestApplication
  let restore: () => void
  let dropInventory: ReturnType<typeof recordingBattleDropInventory>

  beforeEach(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',
      PERSISTENCE_DRIVER: 'memory',
    })
    dropInventory = recordingBattleDropInventory()

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(accounts)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(heroes)
      .overrideProvider(BATTLE_HERO_COMMITMENTS)
      .useValue(recordingBattleCommitments())
      .overrideProvider(BATTLE_DROP_INVENTORY)
      .useValue(dropInventory)
      .overrideProvider(BOT_COMBAT_CATALOG)
      .useValue(catalog)
      .compile()

    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  })

  afterEach(async () => {
    await app.close()
    restore()
  })

  const http = () => request(app.getHttpServer())
  const auth = (token: string) => `Bearer ${token}`

  it('Humano mata a la IA: FINISHED, cero drops, y el humano SI recibe su recompensa normal', async () => {
    const created = await http()
      .post('/api/v1/combat/rooms')
      .set('Authorization', auth('token-a'))
      .send({
        mode: 'PVE',
        teamConfigs: [
          { capacity: 1 },
          { capacity: 1, initialParticipants: [{ kind: 'AI', heroId: 'ai-0' }] },
        ],
        reward: { amount: 0 },
      })

    expect(created.status).toBe(201)
    const roomId = created.body.id as string

    const joined = await http()
      .post(`/api/v1/combat/rooms/${roomId}/join`)
      .set('Authorization', auth('token-a'))
      .send({ team: 'A' })

    expect(joined.body.status).toBe('PREPARING')

    const started = await http()
      .post(`/api/v1/combat/rooms/${roomId}/start`)
      .set('Authorization', auth('token-a'))

    expect(started.status).toBe(200)
    expect(started.body.battle.currentTurn.kind).toBe('HUMAN')

    // Mismo handler real que registra el gateway (DI completa). La IA tiene
    // 1 de Vida y 0 de Defensa: el golpe siempre conecta (Ataque > Defensa),
    // pero HU-25 todavia sortea el TIPO de efecto por fila -- no todo golpe
    // es "Dano". Se reintenta cada vez que vuelve a ser el turno del humano
    // (el turno de la IA ya se disparo solo, HU-93.2) hasta que un golpe
    // efectivo de dano la agote; con Vida 1, el primero que sea "Dano" basta.
    interface RoomBody {
      status: string
      battle: { currentTurn: { kind: string } } | null
      result: { winnerTeamLabel: string; outcome: string } | null
    }
    const handler = app.get(BasicAttackRealtimeHandler)
    const socket = new FakeSocket()
    const readRoom = async (): Promise<RoomBody> =>
      (await http().get(`/api/v1/combat/rooms/${roomId}`).set('Authorization', auth('token-a')))
        .body as RoomBody

    let finished = await readRoom()
    for (let round = 1; round <= 30 && finished.status !== 'FINISHED'; round += 1) {
      await handler.handle(
        socket,
        'sujeto-a',
        {
          type: 'attack',
          commandId: `22222222-2222-4222-8222-${String(round).padStart(12, '0')}`,
          roomId,
          target: { teamLabel: 'B', seat: 0 },
        },
        () => undefined,
      )

      expect(socket.sent.some((message) => JSON.parse(message).type === 'command.rejected')).toBe(
        false,
      )

      // El turno de la IA ya se disparo solo (HU-93.2, fail-open): se espera
      // a que vuelva a ser el turno del humano -- o a que la batalla ya haya
      // terminado -- antes del siguiente intento.
      finished = await waitUntil(
        readRoom,
        (body) => body.status === 'FINISHED' || body.battle?.currentTurn.kind === 'HUMAN',
      )
    }

    if (finished.status !== 'FINISHED') {
      finished = await waitUntil(readRoom, (body) => body.status === 'FINISHED')
    }

    expect(finished.result).toMatchObject({ winnerTeamLabel: 'A', outcome: 'WIN' })

    // HU-93.3: la IA nunca es una entidad economica -- ningun snapshot de
    // drop se capturo nunca para esta sala (PVE: PersistVersusDropDecision
    // tampoco corrio su rama PVP, asi que el golpe letal no genero ningun
    // versusDrop que transferir).
    expect(dropInventory.captures).toEqual([])
    expect(dropInventory.transfers).toEqual([])
    expect(dropInventory.closedBattles).toEqual([])

    // El humano SI conserva su recompensa normal de participacion/victoria
    // (HU-22): esta Task no le quita nada, solo aisla a la IA.
    const reward = await waitUntil(
      async () =>
        (
          await http()
            .get(`/api/v1/combat/rooms/${roomId}/reward`)
            .set('Authorization', auth('token-a'))
        ).body as RewardStatusBody,
      (body) => body.creditsEarned !== null,
    )

    expect(reward.creditsEarned).toBe(2)
  }, 30_000)
})
