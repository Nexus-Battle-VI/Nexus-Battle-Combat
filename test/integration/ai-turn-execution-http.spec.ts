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
import { botCatalogCandidates, supportHero } from '../fixtures/combat-bot-candidates'
import { FakeSocket } from '../fixtures/fake-socket'

/**
 * HU-93.2 (Management#558): control de WIRING del disparo automatico de IA
 * contra el modulo Nest COMPLETO (DI real, memoria), no contra `ExecuteAiTurn`
 * aislado. `test/unit/execute-ai-turn.spec.ts` ya ejercita el orquestador a
 * fondo; esta suite existe para que un cambio futuro de DI (p. ej. olvidar
 * inyectar `AI_TURN_TRIGGER` en un handler) rompa un test, no solo el
 * comportamiento en produccion.
 *
 * El catalogo del bot tiene exactamente UN heroe soporte (MEDICO), sin
 * equipamiento ni epica: la seleccion de `BotParticipantFactory` queda
 * determinista sin importar el valor real sorteado (`nextInt(1)` siempre
 * devuelve 0, y sin candidatos no hay sorteo de equipamiento/epica). Sus
 * habilidades sanan a un `ALLY` que no existe en 1v1, asi que el turno del
 * bot SIEMPRE resuelve a `END_TURN`: no hace falta modelar el motor de
 * resolucion de ataque para que esta prueba sea determinista.
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
    Promise.resolve(botCatalogCandidates({ heroes: [supportHero('MEDICO')] })),
}

/**
 * El disparo es fail-open y deliberadamente NO se espera (`void trigger.afterTransition(...)`,
 * contrato HU-93.2 §7): la respuesta de `/start` no debe bloquearse por el bot.
 * La prueba sondea hasta que el efecto async ya terminado sea observable.
 */
interface BattleRoomBody {
  readonly battle: {
    readonly turnsCompleted: number
    readonly currentTurn: { readonly teamLabel: string; readonly kind: string }
  }
}

const waitUntilTurnsCompleted = async (
  read: () => Promise<BattleRoomBody>,
  expected: number,
): Promise<BattleRoomBody> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = await read()

    if (body.battle.turnsCompleted >= expected) return body

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(`turnsCompleted nunca llego a ${String(expected)}`)
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

describe('HU-93.2 sobre HTTP: wiring real del disparo automatico de IA (Management#558)', () => {
  let app: INestApplication
  let restore: () => void

  /**
   * Una app NUEVA por prueba, NUNCA compartida (`beforeEach`, no `beforeAll`):
   * `BATTLE_RANDOM_SEQUENCE` es una UNICA secuencia de proceso compartida entre
   * los casos de uso de una misma app (ADR-021), asi que reutilizar una app ya
   * usada arrastraria el cursor consumido por una sala anterior y haria que
   * "quien abre la cola" dejara de ser determinista entre pruebas.
   */
  beforeEach(async () => {
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
      .useValue(recordingBattleCommitments())
      .overrideProvider(BATTLE_DROP_INVENTORY)
      .useValue(recordingBattleDropInventory())
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

  it('T-AUTO-01: StartBattle con IA primero la ejecuta sola, sin una segunda peticion', async () => {
    const created = await http()
      .post('/api/v1/combat/rooms')
      .set('Authorization', auth('token-a'))
      .send({
        mode: 'PVE',
        teamConfigs: [
          { capacity: 1, initialParticipants: [{ kind: 'AI', heroId: 'ai-0' }] },
          { capacity: 1 },
        ],
        reward: { amount: 0 },
      })

    expect(created.status).toBe(201)
    expect(created.body.status).toBe('WAITING_FOR_PLAYERS')

    const joined = await http()
      .post(`/api/v1/combat/rooms/${created.body.id as string}/join`)
      .set('Authorization', auth('token-a'))
      .send({ team: 'B' })

    expect(joined.status).toBe(200)
    expect(joined.body.status).toBe('PREPARING')

    const started = await http()
      .post(`/api/v1/combat/rooms/${created.body.id as string}/start`)
      .set('Authorization', auth('token-a'))

    expect(started.status).toBe(200)
    expect(started.body.status).toBe('IN_BATTLE')

    // Con esta semilla por defecto (`COMBAT_RANDOM_SEED` sin configurar =
    // 3.000.000), `BotParticipantFactory` consume el roll de epica (`nextInt(8000)`)
    // ANTES del sorteo de la cola, asi que el resultado difiere del caso sin bot de
    // `battle-start-http.spec.ts`: el primer turno abre con el equipo A, que aqui es
    // la IA.
    expect(started.body.battle.currentTurn.teamLabel).toBe('A')
    expect(started.body.battle.currentTurn.kind).toBe('AI')

    // El disparo es fail-open (`void trigger.afterTransition(...)`): no se espera
    // dentro de `/start`. Ninguna peticion humana adicional lo ejecuta: se sondea
    // la MISMA lectura hasta que el efecto async, ya en curso, sea observable.
    const body = await waitUntilTurnsCompleted(async () => {
      const read = await http()
        .get(`/api/v1/combat/rooms/${created.body.id as string}`)
        .set('Authorization', auth('token-a'))

      expect(read.status).toBe(200)

      return read.body as BattleRoomBody
    }, 1)

    expect(body.battle.turnsCompleted).toBe(1)
    expect(body.battle.currentTurn.teamLabel).toBe('B')
    expect(body.battle.currentTurn.kind).toBe('HUMAN')
  })

  it('T-AUTO-02: una accion humana valida dispara el turno de la IA y el turno vuelve al humano', async () => {
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

    await http()
      .post(`/api/v1/combat/rooms/${created.body.id as string}/join`)
      .set('Authorization', auth('token-a'))
      .send({ team: 'A' })

    const started = await http()
      .post(`/api/v1/combat/rooms/${created.body.id as string}/start`)
      .set('Authorization', auth('token-a'))

    // Mismo orden de consumo de RNG que T-AUTO-01: aqui el equipo A (el
    // humano) abre la cola, al reves que alla porque la IA esta en el equipo B.
    expect(started.body.battle.currentTurn.teamLabel).toBe('A')
    expect(started.body.battle.currentTurn.kind).toBe('HUMAN')

    // Se resuelve el MISMO handler que registra el gateway real (DI completa,
    // `AI_TURN_TRIGGER` incluido) en vez de abrir un WebSocket real: prueba el
    // cableado de produccion sin la mecanica de transporte de
    // `test/db/battle-realtime.e2e.spec.ts`.
    const handler = app.get(BasicAttackRealtimeHandler)
    const socket = new FakeSocket()

    await handler.handle(
      socket,
      'sujeto-a',
      {
        type: 'attack',
        commandId: '11111111-1111-4111-8111-100000000001',
        roomId: created.body.id as string,
        target: { teamLabel: 'B', seat: 0 },
      },
      () => undefined,
    )

    expect(socket.sent.some((message) => JSON.parse(message).type === 'command.rejected')).toBe(
      false,
    )

    const body = await waitUntilTurnsCompleted(async () => {
      const read = await http()
        .get(`/api/v1/combat/rooms/${created.body.id as string}`)
        .set('Authorization', auth('token-a'))

      expect(read.status).toBe(200)

      return read.body as BattleRoomBody
    }, 2)

    // 1 turno del ataque humano + 1 turno de la IA (sin acciones legales ->
    // END_TURN, disparado por el handler sin una segunda peticion humana).
    expect(body.battle.turnsCompleted).toBe(2)
    expect(body.battle.currentTurn.teamLabel).toBe('A')
    expect(body.battle.currentTurn.kind).toBe('HUMAN')
  })
})
