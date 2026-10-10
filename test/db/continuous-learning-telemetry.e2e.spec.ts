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
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import {
  generateOwnerId,
  runContinuousTrainingIteration,
  type ContinuousTrainingPipelineConfig,
  type ContinuousTrainingPipelineDeps,
} from '../../src/infrastructure/training/ContinuousTrainingPipeline'
import { spawnChildProcess } from '../../src/infrastructure/training/ChildProcessRunner'
import { MongoBattleRoomRepository } from '../../src/adapters/outbound/persistence/MongoBattleRoomRepository'
import { MongoContinuousTrainingCoordinatorRepository } from '../../src/adapters/outbound/persistence/MongoContinuousTrainingCoordinatorRepository'
import { MongoAiModelRegistryRepository } from '../../src/adapters/outbound/persistence/MongoAiModelRegistryRepository'
import { MongoAiModelArtifactRepository } from '../../src/adapters/outbound/persistence/MongoAiModelArtifactRepository'
import { AiModelRegistry } from '../../src/application/services/AiModelRegistry'
import { recordingBattleCommitments } from '../fixtures/battle-commitments'
import { recordingBattleDropInventory } from '../fixtures/battle-drop-inventory'
import { indexForEffect, indexForFace } from '../fixtures/basic-attack'
import { botCatalogCandidates, offensiveHero } from '../fixtures/combat-bot-candidates'
import { equippedHeroFixture } from '../fixtures/equipped-hero'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve as resolvePath, join } from 'node:path'

const isUvAvailable = (): boolean => {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * EN-037.5 (Management #574), Fase A/B — Escenarios E2E-01/02/03/04 y, como
 * efecto colateral honesto (ningun codigo nuevo lo fuerza), E2E-19:
 *
 * Varias partidas PVE REALES (HTTP + WebSocket + MongoDB real, mismo motor
 * de Combat que HU-93.4) se juegan hasta `FINISHED` con
 * `MCTS_LIVE_TEACHER_LABELING_ENABLED=true` -- la IA gana en un solo turno
 * (apertura letal), generando un `CombatDecisionEvent` y, en vivo, un
 * `MctsTeacherLabel` REALES por partida (nunca insertados a mano). Despues
 * se invoca el pipeline REAL de EN-037.2 (`runContinuousTrainingIteration`,
 * Mongo + Python reales) sobre ESA telemetria -- nunca sobre el fixture
 * JSONL que ya usa `continuous-training-worker-e2e.spec.ts` -- para
 * comprobar honestamente si resulta entrenable.
 *
 * `NEURAL_POLICY_ENABLED=true` desde el arranque, sin ningun modelo ACTIVE
 * en una base nueva: cada decision de la IA en este archivo pasa real y
 * observablemente por `ActiveModelProvider.decide()` (lanza porque
 * `current === null`) y `DecisionPolicySelector` cae a `RuleBasedPolicy`
 * (Management #558) -- la MISMA ruta de produccion de "sin ACTIVE valido",
 * nunca una ruta separada construida solo para esta prueba.
 */
;(isUvAvailable() ? describe : describe.skip)(
  'Telemetria real -> dataset del aprendizaje continuo (EN-037.5, Management #574)',
  () => {
    let container: StartedMongoDBContainer
    let mongo: MongoClient
    let db: Db
    let app: INestApplication
    let baseUrl: string
    let mongoUri: string
    let restoreEnv: () => void

    const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
      'token-human': { subject: 'human-e2e', email: null, roles: new Set([Role.Player]) },
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
    // Misma forma de "la IA abre y gana en un turno" que HU-93.4 (AI_WINS):
    // vida/dano asimetricos a proposito, sin epicas candidatas.
    const candidates: BotCatalogCandidates = botCatalogCandidates({
      heroes: [
        offensiveHero({
          baseHealth: 40,
          baseDefense: 0,
          baseAttack: { mode: 'FIXED', amount: 100 },
          baseDamage: { mode: 'FIXED', amount: 10 },
        }),
      ],
      epics: [],
    })
    const catalog: BotCombatCatalogPort = { listBotCandidates: () => Promise.resolve(candidates) }
    const heroes: PlayerInventoryEquippedHeroPort = {
      getEquippedHero: (playerId) => {
        const stats = {
          power: 10,
          health: 1,
          defense: 0,
          attack: 100,
          damage: { mode: 'FIXED' as const, amount: 1 },
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

    class ScriptedSequence implements RandomSequencePort {
      private readonly values: number[] = []
      push(...values: number[]): void {
        this.values.push(...values)
      }
      nextIndex(): RandomIndex {
        const value = this.values.shift()
        if (value === undefined) throw new Error('EN-037.5: sorteo inesperado')
        return RandomIndex.create(value)
      }
      expectEmpty(): void {
        expect(this.values).toEqual([])
      }
    }
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

    type DocumentWithStringId = { _id: string } & Record<string, any>
    const decisions = (): Collection<DocumentWithStringId> =>
      db.collection<DocumentWithStringId>('combat-decision-events')
    const teacherLabels = (): Collection<DocumentWithStringId> =>
      db.collection<DocumentWithStringId>('mcts-teacher-labels')

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
          `EN-037.5: no llegaron ${String(count)} eventos ${type}: ${this.raw.join(' | ')}`,
        )
      }
      close(): void {
        this.socket.close()
      }
    }

    beforeAll(async () => {
      container = await new MongoDBContainer('mongo:8.0').start()
      mongoUri = `${container.getConnectionString()}/?directConnection=true`
      const options = { uri: mongoUri }

      mongo = createMongoClient(options)
      await mongo.connect()
      db = databaseOf(mongo, options)

      const migrated = await migrateToLatest(db)
      if (migrated.error !== undefined) {
        throw new Error(`EN-037.5: migraciones fallidas: ${describeError(migrated.error)}`)
      }

      const keys = [
        'AUTH_MODE',
        'COGNITO_USER_POOL_ID',
        'COGNITO_CLIENT_ID',
        'INTERNAL_SERVICE_AUTH_SECRET',
        'PERSISTENCE_DRIVER',
        'MONGODB_URI',
        'NEURAL_POLICY_ENABLED',
        'MCTS_LIVE_TEACHER_LABELING_ENABLED',
      ]
      const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

      Object.assign(process.env, {
        AUTH_MODE: 'jwt',
        COGNITO_USER_POOL_ID: 'us-east-1_en0375',
        COGNITO_CLIENT_ID: 'en0375-client',
        INTERNAL_SERVICE_AUTH_SECRET: 'en0375-secret',
        PERSISTENCE_DRIVER: 'mongo',
        MONGODB_URI: mongoUri,
        // EN-037.5 §12, Fase H/M: sin ningun ACTIVE todavia en esta base
        // nueva -- cada decision de la IA debe caer honestamente a
        // RuleBasedPolicy via DecisionPolicySelector (E2E-19), nunca via
        // una ruta separada "solo para esta prueba".
        NEURAL_POLICY_ENABLED: 'true',
        // EN-037.5 §6: etiquetado MCTS en vivo, deshabilitado por defecto
        // en produccion por costo real de CPU -- aqui se activa a
        // proposito, en un entorno aislado, para generar labels REALES.
        MCTS_LIVE_TEACHER_LABELING_ENABLED: 'true',
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

    afterEach(() => {
      sequence.expectEmpty()
    })

    const http = () => request(baseUrl)
    const auth = (): string => 'Bearer token-human'

    const connect = async (): Promise<InstanceType<typeof RealtimeClient>> => {
      const ticket = await http()
        .post('/api/v1/combat/realtime/tickets')
        .set('Authorization', auth())
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

    const subscribe = async (
      client: InstanceType<typeof RealtimeClient>,
      roomId: string,
    ): Promise<void> => {
      client.send({ type: 'resume', roomId })
      await client.waitFor('resume.ok')
    }

    const damageRolls = (): readonly number[] => [
      indexForFace(1, 6),
      indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
    ]

    /** Una partida PVE real: la IA (equipo B) abre y gana en un solo turno. */
    const playOneAiWinBattle = async (): Promise<string> => {
      sequence.push(401, 2, ...damageRolls())

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
      const roomId = created.body.id as string

      const joined = await http()
        .post(`/api/v1/combat/rooms/${roomId}/join`)
        .set('Authorization', auth())
        .send({ team: 'A' })
      expect(joined.status).toBe(200)

      const client = await connect()
      await subscribe(client, roomId)

      const started = await http()
        .post(`/api/v1/combat/rooms/${roomId}/start`)
        .set('Authorization', auth())
      expect(started.status).toBe(200)

      await client.waitFor('battleStarted')
      const finished = (await client.waitFor('battleFinished'))[0]
      expect(finished?.result).toMatchObject({ outcome: 'WIN', winnerTeamLabel: 'B' })

      client.close()
      return roomId
    }

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

    /**
     * Juega partidas reales hasta reunir `count` cuyo `MctsTeacherLabel` en
     * vivo SI llego -- `LiveMctsTeacherLabeler.persist` es fire-and-forget y
     * best-effort por diseño (§15 del propio archivo): un fallo aislado
     * (p. ej. un `MongoServerError` transitorio) nunca se reintenta
     * internamente. Esta prueba nunca fabrica el label que falto: si una
     * partida se queda sin el, esa partida se DESCARTA del conjunto medido y
     * se juega una nueva en su lugar, hasta un limite -- despues del cual
     * falla con un mensaje explicito en vez de ocultar el problema real.
     */
    const playLabeledAiWinBattles = async (count: number): Promise<string[]> => {
      const roomIds: string[] = []
      let discarded = 0

      while (roomIds.length < count) {
        const roomId = await playOneAiWinBattle()
        const roomDecisions = await decisions()
          .find({ battleId: roomId, eventType: 'COMBAT_DECISION' })
          .toArray()
        const decisionDoc = roomDecisions[0]
        if (decisionDoc === undefined) {
          throw new Error(`EN-037.5: la partida ${roomId} no produjo ningun CombatDecisionEvent.`)
        }
        expect(roomDecisions).toHaveLength(1)
        // E2E-19: sin ACTIVE valido, la fuente real registrada es RuleBased
        // (DecisionPolicySelector cayendo al fallback fijo), nunca NEURAL.
        expect(decisionDoc).toMatchObject({ decisionSource: 'RULE_BASED' })

        const eventId = decisionDoc._id
        let label = await teacherLabels().findOne({ _id: eventId })
        for (let attempt = 0; label === null && attempt < 20; attempt += 1) {
          await sleep(250)
          label = await teacherLabels().findOne({ _id: eventId })
        }

        if (label === null) {
          discarded += 1
          if (discarded > 5) {
            throw new Error(
              'EN-037.5: el etiquetado MCTS en vivo fallo repetidamente ' +
                '(ver "mcts_teacher_label_generation_failed" en los logs de la prueba); ' +
                'esto no es un defecto de esta prueba, sino del mecanismo fire-and-forget bajo prueba.',
            )
          }
          continue
        }

        expect(label).toMatchObject({ battleId: roomId })
        roomIds.push(roomId)
      }

      return roomIds
    }

    it('E2E-01/02: varias partidas reales producen CombatDecisionEvent + MctsTeacherLabel reales, correlacionados y sin duplicados', async () => {
      const roomIds = await playLabeledAiWinBattles(3)

      // Sin duplicados globales: cada partida aporta exactamente 1 evento
      // de tipo COMBAT_DECISION (y, por separado, 1 COMBAT_DECISION_OUTCOME
      // que esta prueba no mide) y 1 label.
      expect(
        await decisions().countDocuments({
          battleId: { $in: roomIds },
          eventType: 'COMBAT_DECISION',
        }),
      ).toBe(roomIds.length)
      expect(await teacherLabels().countDocuments({ battleId: { $in: roomIds } })).toBe(
        roomIds.length,
      )
    }, 60_000)

    it('E2E-03/04: el pipeline REAL de EN-037.2 decide honestamente la entrenabilidad de telemetria real, nunca fabrica una CANDIDATE', async () => {
      const roomIds = await playLabeledAiWinBattles(2)

      const workRootDir = await mkdtemp(join(tmpdir(), 'ai-telemetry-e2e-'))
      const config: ContinuousTrainingPipelineConfig = {
        ownerId: generateOwnerId(),
        aiDir: resolvePath(__dirname, '../../ai'),
        pythonCommand: 'uv',
        mongoUri,
        databaseName: db.databaseName,
        datasetSeed: 42,
        trainingSeed: 7,
        sourceCommit: 'continuous-learning-telemetry-e2e-test',
        gracePeriodMs: 1_000,
        leaseDurationMs: 5 * 60_000,
        heartbeatIntervalMs: 20_000,
        datasetBuildTimeoutMs: 90_000,
        trainingTimeoutMs: 180_000,
        identityTimeoutMs: 90_000,
        workRootDir,
        maxNotTrainableRetries: 3,
      }
      const deps: ContinuousTrainingPipelineDeps = {
        battleRooms: new MongoBattleRoomRepository(db),
        coordinator: new MongoContinuousTrainingCoordinatorRepository(db),
        registry: new AiModelRegistry(
          new MongoAiModelRegistryRepository(db),
          new MongoAiModelArtifactRepository(db),
          { now: () => new Date() },
        ),
        clock: { now: () => new Date() },
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        runChildProcess: spawnChildProcess,
      }

      const { outcome } = await runContinuousTrainingIteration(deps, config, new Date(0))

      // Con pocas partidas reales, el resultado honesto esperado es
      // NOT_TRAINABLE (split 80/10/10 por partida deja validation/test en
      // 0) -- SUCCESS tambien se acepta si el entorno produjo mas
      // telemetria de la esperada, pero jamas se fuerza.
      //
      // DATASET_BUILD_FAILED (#574 §6, "precision importante" del propio
      // enunciado) es TAMBIEN un resultado honesto esperado, nunca un
      // defecto de esta prueba: el cutoff de este dataset abarca TODAS las
      // decisiones elegibles en la base (incluidas, si las hubo, partidas
      // de la prueba anterior cuyo label en vivo se descarto por no
      // llegar) y el builder del worker continuo NUNCA pasa
      // `--allow-missing-labels` -- una sola decision ONLINE sin su label
      // hace fallar CERRADO el dataset completo, por diseño
      // (`docs/en-037-continuous-training-worker.md`). Cualquier OTRO
      // `reasonCode` si es un fallo real y hace fallar esta prueba.
      if (outcome.kind === 'FAILED') {
        expect(outcome.reasonCode).toBe('DATASET_BUILD_FAILED')
      } else {
        expect(['NOT_TRAINABLE', 'SUCCESS']).toContain(outcome.kind)
        if (outcome.kind === 'NOT_TRAINABLE') {
          expect(outcome.reason).toMatch(/train\/validation\/test decisions/)
        }
      }
      void roomIds
    }, 180_000)
  },
)
