/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP, WebSocket y MongoDB se validan como contratos JSON reales */
import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { type Collection, type Db, type MongoClient } from 'mongodb'
import request from 'supertest'
import { WebSocket, type RawData } from 'ws'

import { REALTIME_GATEWAY_OPTIONS } from '../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import {
  BATTLE_DEADLINE_SCHEDULER_OPTIONS,
  BATTLE_RANDOM_SEQUENCE,
  EXECUTE_AI_TURN,
  REWARD_CREDIT_PORT,
  REWARD_GRANT_PORT,
  REWARD_WORKFLOW_SCHEDULER_OPTIONS,
} from '../../src/adapters/inbound/http/tokens'
import {
  ACCOUNT_BATTLE_PROFILE,
  type AccountBattleProfilePort,
} from '../../src/application/ports/AccountBattleProfilePort'
import { BATTLE_DROP_INVENTORY } from '../../src/application/ports/BattleDropInventoryPort'
import { BATTLE_HERO_COMMITMENTS } from '../../src/application/ports/BattleHeroCommitmentPort'
import {
  BOT_COMBAT_CATALOG,
  type BotCatalogCandidates,
  type BotCatalogEpic,
  type BotCombatCatalogPort,
} from '../../src/application/ports/BotCombatCatalogPort'
import {
  PLAYER_INVENTORY_EQUIPPED_HERO,
  type PlayerInventoryEquippedHeroPort,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import type {
  RewardCreditCommand,
  RewardCreditPort,
} from '../../src/application/ports/RewardCreditPort'
import type {
  RewardGrantCommand,
  RewardGrantPort,
} from '../../src/application/ports/RewardGrantPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import type { ExecuteAiTurn } from '../../src/application/use-cases/ExecuteAiTurn'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'
import { recordingBattleDropInventory } from '../fixtures/battle-drop-inventory'
import { indexForEffect, indexForFace } from '../fixtures/basic-attack'
import { botCatalogCandidates, offensiveHero, supportHero } from '../fixtures/combat-bot-candidates'
import { equippedHeroFixture } from '../fixtures/equipped-hero'

/**
 * HU-93.4 / Management#560 — evidencia E2E_HTTP_WS_DB.
 *
 * Componentes reales: servidor Nest escuchando, rutas HTTP, gateway y cliente
 * WebSocket nativos, motor de Combat, ExecuteAiTurn, repositorios Mongo,
 * migraciones, finalizador, RewardWorkflow y telemetria.
 *
 * Dobles limitados a fronteras de otros bounded contexts: JWT/Cognito, Account,
 * Catalog, Player-Inventory y Wallet. Ninguno decide, ejecuta ni finaliza turnos.
 */
const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-human': {
    subject: 'human-e2e',
    email: null,
    roles: new Set([Role.Player]),
  },
  'token-intruder': {
    subject: 'intruder-e2e',
    email: null,
    roles: new Set([Role.Player]),
  },
}

const verifier: TokenVerifierPort = {
  verify: (token) => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const accounts: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `nombre-${subject}`, avatarUrl: null }),
}

type Scenario = 'HUMAN_WINS' | 'AI_WINS' | 'SUPPORT_END_TURN'

let scenario: Scenario = 'HUMAN_WINS'

const epic = (sequence: number): BotCatalogEpic => ({
  productId: `40000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  sku: `epic-${String(sequence)}`,
  name: `Epica ${String(sequence)}`,
  compatibleHeroSubtype: 'GUERRERO_ARMAS',
  specificEffects: [
    {
      kind: 'STAT_MODIFIER',
      target: 'SELF',
      statistic: 'DEFENSE',
      operation: 'INCREASE',
      magnitude: { mode: 'FIXED', amount: 1 },
      stackable: false,
    },
  ],
  powerCost: 0,
  cooldownTurns: 2,
})

const candidatesFor = (current: Scenario): BotCatalogCandidates => {
  if (current === 'SUPPORT_END_TURN') {
    return botCatalogCandidates({ heroes: [supportHero('MEDICO')] })
  }

  const aiWins = current === 'AI_WINS'

  return botCatalogCandidates({
    heroes: [
      offensiveHero({
        baseHealth: aiWins ? 40 : 15,
        baseDefense: 0,
        baseAttack: { mode: 'FIXED', amount: 100 },
        baseDamage: { mode: 'FIXED', amount: aiWins ? 10 : 1 },
      }),
    ],
    // El escenario de victoria humana fuerza el borde positivo del roll 5 %
    // y ofrece dos candidatas compatibles: el snapshot debe contener una sola.
    epics: aiWins ? [] : [epic(1), epic(2)],
  })
}

const catalog: BotCombatCatalogPort = {
  listBotCandidates: () => Promise.resolve(candidatesFor(scenario)),
}

const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) => {
    const aiWins = scenario === 'AI_WINS'
    const stats = {
      power: 10,
      health: aiWins ? 1 : 40,
      defense: 0,
      attack: 100,
      damage: { mode: 'FIXED' as const, amount: aiWins ? 1 : 10 },
      healing: null,
    }

    return Promise.resolve(
      equippedHeroFixture({
        playerId,
        heroId: `hero-${playerId}`,
        subtype: 'GUERRERO_ARMAS',
        baseStats: stats,
        effectiveStats: stats,
        maxPower: stats.power,
        activeEffects: [],
        abilities: [],
        loadoutVersion: 0,
      }),
    )
  },
}

/** Cola estricta: cualquier sorteo extra o faltante convierte la prueba en RED. */
class ScriptedSequence implements RandomSequencePort {
  private readonly values: number[] = []

  push(...values: number[]): void {
    this.values.push(...values)
  }

  nextIndex(): RandomIndex {
    const value = this.values.shift()

    if (value === undefined) throw new Error('HU-93.4: sorteo inesperado')
    return RandomIndex.create(value)
  }

  expectEmpty(): void {
    expect(this.values).toEqual([])
  }

  reset(): void {
    this.values.length = 0
  }
}

class RealtimeClient {
  readonly raw: string[] = []

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data: RawData) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data
      this.raw.push(bytes.toString('utf8'))
    })
  }

  get messages(): Record<string, any>[] {
    return this.raw.map((message) => JSON.parse(message) as Record<string, any>)
  }

  ofType(type: string): Record<string, any>[] {
    return this.messages.filter((message) => message.type === type)
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  async waitFor(type: string, count = 1, timeoutMs = 8_000): Promise<Record<string, any>[]> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const matching = this.ofType(type)
      if (matching.length >= count) return matching
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    throw new Error(
      `HU-93.4: no llegaron ${String(count)} eventos ${type}: ${this.raw.join(' | ')}`,
    )
  }

  close(): void {
    this.socket.close()
  }
}

describe('HU-93.4 E2E: Humano vs IA 1v1 con HTTP + WebSocket + MongoDB real', () => {
  let container: StartedMongoDBContainer
  let mongo: MongoClient
  let db: Db
  let app: INestApplication
  let baseUrl: string
  let restoreEnv: () => void
  const sequence = new ScriptedSequence()
  const commitments = recordingBattleCommitments()
  const drops = recordingBattleDropInventory()
  const creditCalls: RewardCreditCommand[] = []
  const grantCalls: RewardGrantCommand[] = []

  const credits: RewardCreditPort = {
    creditBattleReward: (command) => {
      creditCalls.push(command)
      return Promise.resolve({
        applied: true,
        balance: command.creditsAmount,
        victoryProgress: command.victoryCreditsAmount,
        weeklyChestCount: 0,
        weeklyChestLimit: 3,
        chestEarned: false,
      })
    },
  }

  const grants: RewardGrantPort = {
    grant: (command) => {
      grantCalls.push(command)
      return Promise.resolve({ applied: true })
    },
  }

  const rooms = (): Collection<Record<string, any>> =>
    db.collection<Record<string, any>>('battle-rooms')
  const decisions = (): Collection<Record<string, any>> =>
    db.collection<Record<string, any>>('combat-decision-events')
  const rewardWorkflows = (): Collection<Record<string, any>> =>
    db.collection<Record<string, any>>('reward-workflows')

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const mongoUri = `${container.getConnectionString()}/?directConnection=true`
    const options = { uri: mongoUri }

    mongo = createMongoClient(options)
    await mongo.connect()
    db = databaseOf(mongo, options)

    const migrated = await migrateToLatest(db)
    if (migrated.error !== undefined) {
      throw new Error(`HU-93.4: migraciones fallidas: ${describeError(migrated.error)}`)
    }

    const keys = [
      'AUTH_MODE',
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'INTERNAL_SERVICE_AUTH_SECRET',
      'PERSISTENCE_DRIVER',
      'MONGODB_URI',
      'NEURAL_POLICY_ENABLED',
    ]
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_hu93',
      COGNITO_CLIENT_ID: 'hu93-client',
      INTERNAL_SERVICE_AUTH_SECRET: 'hu93-secret',
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: mongoUri,
      // Fuerza el camino productivo documentado: primaria ausente -> RuleBased.
      NEURAL_POLICY_ENABLED: 'false',
    })
    restoreEnv = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(accounts)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(heroes)
      .overrideProvider(BOT_COMBAT_CATALOG)
      .useValue(catalog)
      .overrideProvider(BATTLE_HERO_COMMITMENTS)
      .useValue(commitments)
      .overrideProvider(BATTLE_DROP_INVENTORY)
      .useValue(drops)
      .overrideProvider(BATTLE_RANDOM_SEQUENCE)
      .useValue(sequence)
      .overrideProvider(REWARD_CREDIT_PORT)
      .useValue(credits)
      .overrideProvider(REWARD_GRANT_PORT)
      .useValue(grants)
      .overrideProvider(BATTLE_DEADLINE_SCHEDULER_OPTIONS)
      .useValue({ autoStart: false, tickMs: 1_000 })
      .overrideProvider(REWARD_WORKFLOW_SCHEDULER_OPTIONS)
      .useValue({ autoStart: false, tickMs: 1_000, batchSize: 50, reconcileWindowMs: 86_400_000 })
      .overrideProvider(REALTIME_GATEWAY_OPTIONS)
      .useValue({ authTimeoutMs: 60_000, heartbeatIntervalMs: 60_000 })
      .compile()

    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.listen(0, '127.0.0.1')

    const address = app.getHttpServer().address() as { port: number }
    baseUrl = `http://127.0.0.1:${String(address.port)}`
  }, 180_000)

  afterAll(async () => {
    await app.close()
    await mongo.close()
    await container.stop()
    restoreEnv()
  })

  beforeEach(() => {
    sequence.reset()
    creditCalls.length = 0
    grantCalls.length = 0
    commitments.commits.length = 0
    commitments.releases.length = 0
    drops.captures.length = 0
    drops.transfers.length = 0
    drops.closedBattles.length = 0
  })

  afterEach(() => {
    sequence.expectEmpty()
  })

  const http = () => request(baseUrl)
  const auth = (token = 'token-human'): string => `Bearer ${token}`

  const connect = async (token = 'token-human'): Promise<RealtimeClient> => {
    const ticket = await http()
      .post('/api/v1/combat/realtime/tickets')
      .set('Authorization', auth(token))

    expect(ticket.status).toBe(201)

    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/v1/combat/realtime`)
    const client = new RealtimeClient(socket)

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    client.send({ type: 'auth', ticket: ticket.body.ticket })
    await client.waitFor('auth.ok')
    return client
  }

  const readRoom = async (roomId: string): Promise<Record<string, any>> => {
    const response = await http().get(`/api/v1/combat/rooms/${roomId}`).set('Authorization', auth())

    expect(response.status).toBe(200)
    return response.body as Record<string, any>
  }

  const waitUntil = async <T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    description: string,
  ): Promise<T> => {
    const deadline = Date.now() + 8_000

    while (Date.now() < deadline) {
      const value = await read()
      if (done(value)) return value
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    throw new Error(`HU-93.4: timeout esperando ${description}`)
  }

  const createPreparingRoom = async (): Promise<string> => {
    const created = await http()
      .post('/api/v1/combat/rooms')
      .set('Authorization', auth())
      .send({
        mode: 'PVE',
        teamConfigs: [
          { capacity: 1 },
          { capacity: 1, initialParticipants: [{ kind: 'AI', heroId: 'client-placeholder' }] },
        ],
        reward: { amount: 0 },
      })

    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ mode: 'PVE', status: 'WAITING_FOR_PLAYERS' })
    expect(created.body.teams[1].participants).toEqual([
      expect.objectContaining({ kind: 'AI', playerId: null, displayName: null }),
    ])

    const roomId = created.body.id as string
    const joined = await http()
      .post(`/api/v1/combat/rooms/${roomId}/join`)
      .set('Authorization', auth())
      .send({ team: 'A' })

    expect(joined.status).toBe(200)
    expect(joined.body.status).toBe('PREPARING')
    return roomId
  }

  const subscribe = async (client: RealtimeClient, roomId: string): Promise<void> => {
    client.send({ type: 'resume', roomId })
    await client.waitFor('resume.ok')
  }

  const attack = (client: RealtimeClient, roomId: string, commandId: string): void => {
    client.send({
      type: 'attack',
      commandId,
      roomId,
      target: { teamLabel: 'B', seat: 0 },
    })
  }

  const damageRolls = (): readonly number[] => [
    indexForFace(1, 6),
    indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
  ]

  it('CA-01/02/03/04/06/07: humano gana tras alternancia real; IA decide sola con RuleBased y todo queda en Mongo', async () => {
    scenario = 'HUMAN_WINS'
    // Epic roll 399/8000 (dentro del 5 %), primera de dos epicas, equipo A abre;
    // luego humano -> IA -> humano, todos con dano determinista.
    sequence.push(400, 1, 1, ...damageRolls(), ...damageRolls(), ...damageRolls())

    const roomId = await createPreparingRoom()
    const client = await connect()
    await subscribe(client, roomId)

    const started = await http()
      .post(`/api/v1/combat/rooms/${roomId}/start`)
      .set('Authorization', auth())

    expect(started.status).toBe(200)
    expect(started.body.battle.currentTurn).toMatchObject({ kind: 'HUMAN', teamLabel: 'A' })
    await client.waitFor('battleStarted')

    const persistedStart = await rooms().findOne({ _id: roomId as never })
    const aiSnapshot = persistedStart?.battle.combatants.find(
      (combatant: Record<string, any>) => combatant.teamLabel === 'B',
    )

    expect(aiSnapshot).toMatchObject({
      profile: {
        heroId: '10000000-0000-4000-8000-000000000001',
        subtype: 'GUERRERO_ARMAS',
        epic: { epicProductId: '40000000-0000-4000-8000-000000000001' },
      },
    })
    expect(Array.isArray(aiSnapshot?.profile.epic)).toBe(false)
    expect(commitments.commits).toEqual([
      expect.objectContaining({ roomId, playerId: 'human-e2e', heroId: 'hero-human-e2e' }),
    ])

    const firstCommand = '11111111-1111-4111-8111-000000000001'
    attack(client, roomId, firstCommand)

    const afterAi = await waitUntil(
      () => readRoom(roomId),
      (room) => room.battle?.turnsCompleted === 2 && room.battle?.currentTurn?.kind === 'HUMAN',
      'la accion humana, el turno autonomo IA y el retorno al humano',
    )

    expect(afterAi.status).toBe('IN_BATTLE')
    await client.waitFor('basicAttackResolved', 2)
    expect(client.ofType('basicAttackResolved')).toHaveLength(2)
    expect(client.raw.join('\n')).not.toMatch(/seed|mt19937|ticket|jwt/i)

    const secondCommand = '11111111-1111-4111-8111-000000000002'
    attack(client, roomId, secondCommand)
    const finishedEvent = (await client.waitFor('battleFinished'))[0]

    expect(finishedEvent?.result).toMatchObject({
      reason: 'ELIMINATION',
      outcome: 'WIN',
      winnerTeamLabel: 'A',
      participants: expect.arrayContaining([
        expect.objectContaining({ kind: 'HUMAN', playerId: 'human-e2e', result: 'WON' }),
        expect.objectContaining({ kind: 'AI', playerId: null, result: 'LOST' }),
      ]),
    })

    const persisted = await rooms().findOne({ _id: roomId as never })
    expect(persisted?.status).toBe('FINISHED')
    expect(
      persisted?.events.map((event: Record<string, any>) => event.type as unknown as string),
    ).toEqual([
      'battleStarted',
      'basicAttackResolved',
      'basicAttackResolved',
      'basicAttackResolved',
      'battleFinished',
    ])

    const telemetry = await decisions()
      .find({ battleId: roomId })
      .sort({ decisionSequence: 1 })
      .toArray()
    const decisionEvents = telemetry.filter((event) => event.eventType === 'COMBAT_DECISION')
    const outcomeEvents = telemetry.filter((event) => event.eventType === 'COMBAT_DECISION_OUTCOME')

    expect(decisionEvents.map((event) => event.decisionSource as unknown as string)).toEqual([
      'HUMAN',
      'RULE_BASED',
      'HUMAN',
    ])
    expect(decisionEvents[1]?.selectedAction).toMatchObject({ kind: 'BASIC_ATTACK' })
    expect(decisionEvents[1]?.legalActions).toContainEqual(decisionEvents[1]?.selectedAction)
    expect(outcomeEvents).toHaveLength(1)
    expect(outcomeEvents[0]?.outcome).toMatchObject({ outcome: 'WIN', winnerTeamLabel: 'A' })

    await waitUntil(
      () => rewardWorkflows().find({ battleId: roomId }).toArray(),
      (workflows) => workflows.length === 1,
      'el RewardWorkflow durable del humano',
    )
    expect(await rewardWorkflows().countDocuments({ battleId: roomId })).toBe(1)
    expect(creditCalls).toEqual([
      expect.objectContaining({ battleId: roomId, playerId: 'human-e2e', creditsAmount: 2 }),
    ])
    expect(grantCalls).toEqual([])
    expect(drops.captures).toEqual([])
    expect(drops.transfers).toEqual([])
    expect(drops.closedBattles).toEqual([])

    // Repetir el commandId devuelve el evento ya persistido; no finaliza ni paga otra vez.
    attack(client, roomId, secondCommand)
    await client.waitFor('basicAttackResolved', 4)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await rooms().findOne({ _id: roomId as never })).toEqual(persisted)
    expect(
      await decisions().countDocuments({ battleId: roomId, eventType: 'COMBAT_DECISION_OUTCOME' }),
    ).toBe(1)
    expect(await rewardWorkflows().countDocuments({ battleId: roomId })).toBe(1)
    expect(creditCalls).toHaveLength(1)

    client.close()
  }, 30_000)

  it('CA-03/05/06/07: la IA abre y gana sin comando humano; el humano conserva participacion y la IA no entra en economia', async () => {
    scenario = 'AI_WINS'
    // Epic roll negativo, equipo B (IA) abre, ataque letal de la IA.
    sequence.push(401, 2, ...damageRolls())

    const roomId = await createPreparingRoom()
    const client = await connect()
    await subscribe(client, roomId)

    const started = await http()
      .post(`/api/v1/combat/rooms/${roomId}/start`)
      .set('Authorization', auth())

    expect(started.status).toBe(200)
    expect(started.body.battle.currentTurn).toMatchObject({ kind: 'AI', teamLabel: 'B' })
    await client.waitFor('battleStarted')
    const finished = (await client.waitFor('battleFinished'))[0]

    expect(finished?.result).toMatchObject({
      outcome: 'WIN',
      winnerTeamLabel: 'B',
      participants: expect.arrayContaining([
        expect.objectContaining({ kind: 'AI', playerId: null, result: 'WON' }),
        expect.objectContaining({ kind: 'HUMAN', playerId: 'human-e2e', result: 'LOST' }),
      ]),
    })

    const aiDecisions = await decisions()
      .find({ battleId: roomId, eventType: 'COMBAT_DECISION' })
      .toArray()
    expect(aiDecisions).toHaveLength(1)
    expect(aiDecisions[0]).toMatchObject({ decisionSource: 'RULE_BASED' })

    await waitUntil(
      () => rewardWorkflows().find({ battleId: roomId }).toArray(),
      (workflows) => workflows.length === 1,
      'la recompensa de participacion del humano derrotado',
    )
    const workflows = await rewardWorkflows().find({ battleId: roomId }).toArray()
    expect(workflows).toHaveLength(1)
    expect(workflows[0]).toMatchObject({ playerId: 'human-e2e', creditsAmount: 1 })
    await waitUntil(
      () => Promise.resolve(creditCalls.filter((call) => call.battleId === roomId)),
      (calls) => calls.length === 1,
      'la acreditacion humana posterior al workflow durable',
    )
    expect(creditCalls).toEqual([
      expect.objectContaining({ battleId: roomId, playerId: 'human-e2e', creditsAmount: 1 }),
    ])
    expect(creditCalls.some((call) => call.playerId.includes('ai'))).toBe(false)
    expect(drops.captures).toEqual([])
    expect(drops.transfers).toEqual([])

    const executeAiTurn = app.get<ExecuteAiTurn>(EXECUTE_AI_TURN)
    await expect(executeAiTurn.execute(roomId)).resolves.toBe(false)
    await expect(executeAiTurn.execute(roomId)).resolves.toBe(false)
    expect(
      await decisions().countDocuments({ battleId: roomId, eventType: 'COMBAT_DECISION_OUTCOME' }),
    ).toBe(1)
    expect(await rewardWorkflows().countDocuments({ battleId: roomId })).toBe(1)
    expect(creditCalls).toHaveLength(1)

    client.close()
  }, 30_000)

  it('CA-03/04/07: un Medico sin accion legal produce END_TURN SYSTEM y nunca requiere identidad o comando humano', async () => {
    scenario = 'SUPPORT_END_TURN'
    sequence.push(401, 2)

    const roomId = await createPreparingRoom()
    const client = await connect()
    await subscribe(client, roomId)

    const started = await http()
      .post(`/api/v1/combat/rooms/${roomId}/start`)
      .set('Authorization', auth())

    expect(started.body.battle.currentTurn.kind).toBe('AI')
    await client.waitFor('battleStarted')
    await client.waitFor('turnAdvanced')

    const after = await readRoom(roomId)
    expect(after.battle).toMatchObject({
      turnsCompleted: 1,
      currentTurn: { kind: 'HUMAN', teamLabel: 'A' },
    })

    const [decision] = await decisions()
      .find({ battleId: roomId, eventType: 'COMBAT_DECISION' })
      .toArray()
    expect(decision).toMatchObject({
      schemaVersion: 2,
      decisionSource: 'SYSTEM',
      legalActions: [],
      selectedAction: { kind: 'END_TURN' },
    })

    const intruder = await connect('token-intruder')
    intruder.send({ type: 'resume', roomId })
    const [rejected] = await intruder.waitFor('command.rejected')
    expect(rejected).toMatchObject({ code: 'NOT_A_PARTICIPANT' })

    intruder.close()
    client.close()
  }, 30_000)
})
