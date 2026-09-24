/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return -- las respuestas y eventos del servidor real (HTTP, WebSocket y MongoDB) son JSON dinamico; el contrato se verifica con las aserciones, no con tipos */
import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { type Collection, type Db, type MongoClient, MongoServerError } from 'mongodb'
import { WebSocket } from 'ws'

import { REALTIME_GATEWAY_OPTIONS } from '../../src/adapters/inbound/ws/BattleRoomRealtimeGateway'
import {
  BATTLE_DEADLINE_SCHEDULER_OPTIONS,
  PROCESS_BATTLE_DEADLINES,
} from '../../src/adapters/inbound/http/tokens'
import type { ProcessBattleDeadlines } from '../../src/application/use-cases/ProcessBattleDeadlines'
import {
  BATTLE_DEADLINE_BOOK,
  type BattleDeadlineBookPort,
} from '../../src/application/ports/BattleDeadlineBookPort'
import {
  BATTLE_RESULT_PUBLISHER,
  type BattleFinishedNotification,
  type BattleResultPublisherPort,
} from '../../src/application/ports/BattleResultPublisherPort'
import { BATTLE_RANDOM_SEQUENCE } from '../../src/adapters/inbound/http/tokens'
import {
  ACCOUNT_BATTLE_PROFILE,
  type AccountBattleProfilePort,
} from '../../src/application/ports/AccountBattleProfilePort'
import {
  PLAYER_INVENTORY_EQUIPPED_HERO,
  type EquippedHero,
  type PlayerInventoryEquippedHeroPort,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import { CLOCK } from '../../src/application/ports/ClockPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { IntervalBattleDeadlineScheduler } from '../../src/adapters/outbound/system/IntervalBattleDeadlineScheduler'
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
  down as downFinishMigration,
  up as upFinishMigration,
} from '../../src/adapters/outbound/persistence/migrations/009-battle-rooms-finish'
import { up as upSkillEffectsMigration } from '../../src/adapters/outbound/persistence/migrations/016-battle-rooms-skill-effects'
import { indexForEffect, indexForFace } from '../fixtures/basic-attack'
import { MutableClock } from '../fixtures/chat-harness'
import { equippedHeroFixture, shieldStrikeAbility } from '../fixtures/equipped-hero'

/**
 * VALIDACION DE HU-21 (Task #420) a nivel de PROTOCOLO: MongoDB REAL
 * (Testcontainers), servidor Nest REAL y DOS clientes WebSocket REALES (`ws`).
 *
 * Solo se sustituyen las fronteras EXTERNAS a Combat (JWT, Account,
 * Player-Inventory y la secuencia HU-24) y el RELOJ (`MutableClock`), para que
 * las fronteras de tiempo sean deterministas y ningun test dependa del azar.
 * El planificador se mueve a mano (`autoStart: false` + `tick()`).
 *
 * NO sustituye la prueba manual con dos navegadores (V4, runbook de
 * aceptacion); esto demuestra el ciclo completo a nivel de protocolo.
 */
const SUBJECTS: Readonly<Record<string, string>> = {
  'token-a': 'sujeto-a',
  'token-b': 'sujeto-b',
}

const verifier: TokenVerifierPort = {
  verify: (token) => {
    const subject = SUBJECTS[token]

    if (subject === undefined) {
      return Promise.reject(new TokenVerificationError())
    }

    const identity: VerifiedIdentity = { subject, email: null, roles: new Set([Role.Player]) }

    return Promise.resolve(identity)
  },
}

const accounts: AccountBattleProfilePort = {
  getBattleProfile: (subject) =>
    Promise.resolve({ subject, displayName: `nombre-de-${subject}`, avatarUrl: null }),
}

/** Vida maxima por jugador: editable por prueba (S-01, S-10, S-13). */
const maxHealthOf: Record<string, number> = { 'sujeto-a': 44, 'sujeto-b': 44 }
/** Poder maximo por jugador: a 0 fuerza la degradacion (S-02). */
const maxPowerOf: Record<string, number> = { 'sujeto-a': 10, 'sujeto-b': 10 }

const heroOf = (playerId: string): EquippedHero =>
  equippedHeroFixture({
    playerId,
    heroId: `heroe-de-${playerId}`,
    subtype: 'GUERRERO_ARMAS',
    loadoutVersion: 0,
    activeEffects: [],
    maxPower: maxPowerOf[playerId] ?? 10,
    abilities: [shieldStrikeAbility],
    effectiveStats: {
      power: maxPowerOf[playerId] ?? 10,
      health: maxHealthOf[playerId] ?? 44,
      defense: 11,
      attack: 10,
      damage: { mode: 'DICE', count: 1, sides: 6 },
      healing: null,
    },
  })

const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) => Promise.resolve(heroOf(playerId)),
}

/** Secuencia HU-24 guionizada: un sorteo de mas rompe el test; uno de menos se ve al final. */
class ScriptedQueue implements RandomSequencePort {
  private readonly queue: number[] = []
  used = 0

  push(...indices: number[]): void {
    this.queue.push(...indices)
  }

  pending(): number {
    return this.queue.length
  }

  nextIndex(): RandomIndex {
    const value = this.queue.shift()

    if (value === undefined) {
      throw new Error('sorteo inesperado: la secuencia guionizada esta vacia')
    }

    this.used += 1

    return RandomIndex.create(value)
  }
}

class Client {
  readonly raw: string[] = []
  readonly closes: number[] = []

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.raw.push(
        Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(Buffer.concat([Buffer.from(data as ArrayBuffer)])),
      )
    })
    ws.on('close', (code) => {
      this.closes.push(code)
    })
  }

  get messages(): any[] {
    return this.raw.map((text) => JSON.parse(text) as unknown)
  }

  ofType(type: string): any[] {
    return this.messages.filter((message) => message.type === type)
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload))
  }

  async waitFor(type: string, count = 1, timeoutMs = 5_000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.ofType(type).length >= count) {
        return this.ofType(type)
      }

      await new Promise((resolve) => setTimeout(resolve, 15))
    }

    throw new Error(
      `No llego ${String(count)} mensaje(s) "${type}" en ${String(timeoutMs)} ms: ${this.raw.join(' | ')}`,
    )
  }

  close(): void {
    this.ws.close()
  }
}

describe('HU-21 de extremo a extremo (protocolo): finalizacion entre dos clientes WebSocket reales, Combat y MongoDB', () => {
  let container: StartedMongoDBContainer
  let mongo: MongoClient
  let db: Db
  let mongoUri: string
  let app: INestApplication
  let port: number
  let restoreEnv: () => void
  let clock: MutableClock
  const sequence = new ScriptedQueue()
  const notifications: BattleFinishedNotification[] = []

  const rooms = (): Collection<Record<string, any>> =>
    db.collection<Record<string, any>>('battle-rooms')

  const publisherSpy: BattleResultPublisherPort = {
    publish: (notification) => {
      notifications.push(notification)
    },
  }

  const boot = async (current: MutableClock): Promise<void> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(accounts)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(heroes)
      .overrideProvider(BATTLE_RANDOM_SEQUENCE)
      .useValue(sequence)
      .overrideProvider(CLOCK)
      .useValue(current)
      .overrideProvider(BATTLE_DEADLINE_SCHEDULER_OPTIONS)
      .useValue({ autoStart: false, tickMs: 1_000 })
      .overrideProvider(REALTIME_GATEWAY_OPTIONS)
      .useValue({ authTimeoutMs: 60_000, heartbeatIntervalMs: 60_000 })
      .overrideProvider(BATTLE_RESULT_PUBLISHER)
      .useValue(publisherSpy)
      .compile()

    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.listen(0, '127.0.0.1')

    const address = app.getHttpServer().address() as { port: number }

    port = address.port
  }

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    mongoUri = `${container.getConnectionString()}/?directConnection=true`

    const options = { uri: mongoUri }

    mongo = createMongoClient(options)
    await mongo.connect()
    db = databaseOf(mongo, options)

    const { error } = await migrateToLatest(db)

    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }

    const keys = [
      'AUTH_MODE',
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'INTERNAL_SERVICE_AUTH_SECRET',
      'PERSISTENCE_DRIVER',
      'MONGODB_URI',
    ]
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: mongoUri,
    })
    restoreEnv = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key)
        } else {
          process.env[key] = value
        }
      }
    }

    clock = new MutableClock(new Date('2026-09-22T10:00:00.000Z'))

    await boot(clock)
  }, 180_000)

  afterAll(async () => {
    await app.close()
    await mongo.close()
    await container.stop()
    restoreEnv()
  })

  beforeEach(() => {
    maxHealthOf['sujeto-a'] = 44
    maxHealthOf['sujeto-b'] = 44
    maxPowerOf['sujeto-a'] = 10
    maxPowerOf['sujeto-b'] = 10
    notifications.length = 0
  })

  const url = (path: string): string => `http://127.0.0.1:${String(port)}/api/v1/combat${path}`

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, any> }> => {
    const response = await fetch(url(path), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }

  const connect = async (token: string): Promise<Client> => {
    const ticket = (await call('POST', '/realtime/tickets', token)).body.ticket as string
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/v1/combat/realtime`)
    const client = new Client(ws)

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })
    client.send({ type: 'auth', ticket })
    await client.waitFor('auth.ok')

    return client
  }

  const settle = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const scheduler = (): IntervalBattleDeadlineScheduler =>
    app.get<IntervalBattleDeadlineScheduler>(IntervalBattleDeadlineScheduler)

  const book = (): BattleDeadlineBookPort => app.get<BattleDeadlineBookPort>(BATTLE_DEADLINE_BOOK)

  const processDeadlines = (): ProcessBattleDeadlines =>
    app.get<ProcessBattleDeadlines>(PROCESS_BATTLE_DEADLINES)

  /** Mueve el reloj y deja que el barrido procese lo que vencio. */
  const advance = async (ms: number): Promise<void> => {
    clock.advance(ms)
    await scheduler().tick()
    await settle()
  }

  const document = async (roomId: string): Promise<Record<string, any>> => {
    const found = await rooms().findOne({ _id: roomId as never })

    if (found === null) {
      throw new Error('la sala no esta en MongoDB')
    }

    return found
  }

  const preparingRoom = async (): Promise<string> => {
    const created = await call('POST', '/rooms', 'token-a', {
      mode: 'PVP',
      teamConfigs: [{ capacity: 1, initialParticipants: [{ kind: 'HUMAN' }] }, { capacity: 1 }],
      reward: { amount: 10 },
    })

    expect(created.status).toBe(201)

    const joined = await call('POST', `/rooms/${created.body.id as string}/join`, 'token-b', {})

    expect(joined.body.status).toBe('PREPARING')

    return created.body.id as string
  }

  interface StartedBattle {
    readonly roomId: string
    readonly a: Client
    readonly b: Client | null
  }

  /** Batalla 1v1 iniciada. Por defecto los dos clientes estan presentes. */
  const startedBattle = async (connectB = true): Promise<StartedBattle> => {
    const roomId = await preparingRoom()
    const a = await connect('token-a')
    const b = connectB ? await connect('token-b') : null

    a.send({ type: 'resume', roomId })
    await a.waitFor('resume.ok')

    if (b !== null) {
      b.send({ type: 'resume', roomId })
      await b.waitFor('resume.ok')
    }

    // La cola guionizada debe estar vacia: si una prueba dejo indices, el
    // siguiente test los consumiria y el fallo apareceria lejos de su causa.
    expect(sequence.pending()).toBe(0)
    sequence.push(1)
    const started = await call('POST', `/rooms/${roomId}/start`, 'token-a')
    expect(started.status).toBe(200)
    await a.waitFor('battleStarted')

    if (b !== null) {
      await b.waitFor('battleStarted')
    }

    expect(started.body.battle.currentTurn.playerId).toBe('sujeto-a')

    return { roomId, a, b }
  }

  const attack = (roomId: string, commandId: string): Record<string, unknown> => ({
    type: 'attack',
    commandId,
    roomId,
    target: { teamLabel: 'B', seat: 0 },
  })

  const skill = (roomId: string, commandId: string): Record<string, unknown> => ({
    type: 'useSkill',
    commandId,
    roomId,
    abilityId: shieldStrikeAbility.abilityId,
    target: { teamLabel: 'B', seat: 0 },
  })

  const hit = (): void => {
    sequence.push(
      indexForFace(5, 6),
      indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage),
      indexForFace(6, 6),
    )
  }

  /** Cambia la Vida y/o la Vida maxima de los combatientes en el documento real. */
  const setHealth = async (
    roomId: string,
    entries: readonly { teamLabel: string; seat: number; current: number; max: number }[],
  ): Promise<void> => {
    const found = await document(roomId)
    const combatants = found.battle.combatants as any[]

    for (const entry of entries) {
      const combatant = combatants.find(
        (candidate) => candidate.teamLabel === entry.teamLabel && candidate.seat === entry.seat,
      )

      combatant.currentHealth = entry.current
      combatant.profile.maxHealth = entry.max
    }

    await rooms().updateOne(
      { _id: roomId as never },
      { $set: { 'battle.combatants': combatants } as never },
    )
  }

  describe('eliminacion (S-01, S-02, S-20, S-21, S-26)', () => {
    it('S-01/S-21: el golpe letal 1v1 cierra la batalla; ambos clientes reciben LOS MISMOS bytes de la accion y de `battleFinished`', async () => {
      maxHealthOf['sujeto-b'] = 5

      const { roomId, a, b } = await startedBattle()
      const before = await document(roomId)

      hit()
      a.send(attack(roomId, 'cmd-letal'))

      await a.waitFor('battleFinished')
      await b?.waitFor('battleFinished')

      const actionA = a.ofType('basicAttackResolved')[0]
      const finalA = a.ofType('battleFinished')[0]
      const actionB = b?.ofType('basicAttackResolved')[0]
      const finalB = b?.ofType('battleFinished')[0]

      expect(finalA.seq).toBe(Number(actionA.seq) + 1)
      expect(JSON.stringify(actionA)).toBe(JSON.stringify(actionB))
      expect(JSON.stringify(finalA)).toBe(JSON.stringify(finalB))
      expect(finalA.result).toMatchObject({
        reason: 'ELIMINATION',
        outcome: 'WIN',
        winnerTeamLabel: 'A',
        tiebreak: null,
        disconnected: null,
      })
      expect(finalA.battle.deadlines).toBeUndefined()

      const after = await document(roomId)

      expect(after.status).toBe('FINISHED')
      expect(after.version).toBe(Number(before.version) + 1)
      expect(after.result).toEqual(finalA.result)
      expect(after.events.map((event: any) => event.type)).toEqual([
        'battleStarted',
        'basicAttackResolved',
        'battleFinished',
      ])
      expect(Number(after.events[1].seq) + 1).toBe(after.events[2].seq)
      expect(after.battle.combatants[0].currentPower).toBe(10)

      a.close()
      b?.close()
    })

    it('S-02: una habilidad letal finaliza en su misma escritura; una habilidad degradada por Poder insuficiente tambien', async () => {
      maxHealthOf['sujeto-b'] = 5
      const { roomId, a, b } = await startedBattle()

      hit()
      a.send(skill(roomId, 'cmd-habilidad'))
      await a.waitFor('battleFinished')
      await b?.waitFor('battleFinished')

      expect(Number(a.ofType('skillUsed')[0].seq) + 1).toBe(a.ofType('battleFinished')[0].seq)
      expect((await document(roomId)).result.reason).toBe('ELIMINATION')
      a.close()
      b?.close()

      // Degradada: Poder maximo 0 -> ataque basico con `degradedFrom`.
      maxHealthOf['sujeto-b'] = 5
      maxPowerOf['sujeto-a'] = 0
      const second = await startedBattle()

      hit()
      second.a.send(skill(second.roomId, 'cmd-degradada'))
      await second.a.waitFor('battleFinished')
      await second.b?.waitFor('battleFinished')

      expect(second.a.ofType('basicAttackResolved')[0].degradedFrom).toMatchObject({
        reason: 'INSUFFICIENT_POWER',
      })
      expect(second.a.ofType('battleFinished')[0].result.reason).toBe('ELIMINATION')
      second.a.close()
      second.b?.close()
    })

    it('S-20: tras el final, `attack` y `useSkill` responden BATTLE_NOT_ACTIVE sin sorteos y sin cambios', async () => {
      maxHealthOf['sujeto-b'] = 5
      const { roomId, a, b } = await startedBattle()

      hit()
      a.send(attack(roomId, 'cmd-letal'))
      await a.waitFor('battleFinished')

      const afterFinish = await document(roomId)
      const used = sequence.used

      a.send(attack(roomId, 'cmd-tarde'))
      await a.waitFor('command.rejected')

      expect(a.ofType('command.rejected').at(-1)).toMatchObject({
        command: 'attack',
        code: 'BATTLE_NOT_ACTIVE',
      })

      a.send(skill(roomId, 'cmd-habilidad-tarde'))
      await a.waitFor('command.rejected', 2)

      expect(a.ofType('command.rejected').at(-1)).toMatchObject({
        command: 'useSkill',
        code: 'BATTLE_NOT_ACTIVE',
      })
      expect(sequence.used).toBe(used)
      expect(await document(roomId)).toEqual(afterFinish)

      a.close()
      b?.close()
    })

    it('S-26: un mensaje con `winner`/`result`/`reason` se rechaza como mal formado', async () => {
      const { roomId, a, b } = await startedBattle()
      const before = await document(roomId)

      a.send({ ...attack(roomId, 'cmd-falso'), winner: 'A' })
      await a.waitFor('command.rejected')

      expect(a.ofType('command.rejected')[0]).toMatchObject({
        command: 'attack',
        code: 'MALFORMED_COMMAND',
      })

      a.send({ ...attack(roomId, 'cmd-falso-2'), result: { outcome: 'WIN' }, reason: 'TIME_LIMIT' })
      await a.waitFor('command.rejected', 2)

      expect(a.ofType('command.rejected').at(-1)).toMatchObject({ code: 'MALFORMED_COMMAND' })
      expect((await document(roomId)).version).toBe(before.version)

      a.close()
      b?.close()
    })
  })

  describe('desconexion con gracia (S-04 a S-08)', () => {
    it('S-04/S-05: cerrar la ultima conexion de A no finaliza a 29 999 ms y finaliza a 30 000 ms (gana B)', async () => {
      const { roomId, a, b } = await startedBattle()

      a.close()
      await settle()

      await advance(29_999)

      expect((await document(roomId)).status).toBe('IN_BATTLE')
      expect(b?.ofType('battleFinished') ?? []).toHaveLength(0)

      await advance(1)

      await b?.waitFor('battleFinished')

      const final = b?.ofType('battleFinished')[0]

      expect(final.result).toMatchObject({
        reason: 'DISCONNECTION',
        outcome: 'WIN',
        winnerTeamLabel: 'B',
        disconnected: { teamLabel: 'A', seat: 0 },
      })
      expect((await document(roomId)).status).toBe('FINISHED')
      b?.close()
    })

    it('S-06: reconectar y hacer `resume` dentro de la gracia cancela el abandono', async () => {
      const { roomId, a, b } = await startedBattle()

      a.close()
      await settle()
      clock.advance(10_000)

      const again = await connect('token-a')

      again.send({ type: 'resume', roomId })
      await again.waitFor('resume.ok')

      await advance(20_000)

      expect((await document(roomId)).status).toBe('IN_BATTLE')
      expect(again.ofType('battleFinished')).toHaveLength(0)

      again.close()
      b?.close()
    })

    it('S-07: cerrar una de dos pestanas NO ausenta; cerrar la ultima si', async () => {
      const { roomId, a, b } = await startedBattle()
      const secondTab = await connect('token-a')

      secondTab.send({ type: 'resume', roomId })
      await secondTab.waitFor('resume.ok')

      a.close()
      await settle()
      await advance(30_000)

      expect((await document(roomId)).status).toBe('IN_BATTLE')

      secondTab.close()
      await settle()
      await advance(30_000)

      await b?.waitFor('battleFinished')

      expect(b?.ofType('battleFinished')[0].result).toMatchObject({
        reason: 'DISCONNECTION',
        winnerTeamLabel: 'B',
      })
      b?.close()
    })

    it('S-08: un participante que nunca hizo `resume` empieza su gracia en `startedAt`', async () => {
      const { roomId, a, b } = await startedBattle(false)

      expect(b).toBeNull()

      await advance(29_999)

      expect((await document(roomId)).status).toBe('IN_BATTLE')

      await advance(1)

      await a.waitFor('battleFinished')

      expect(a.ofType('battleFinished')[0].result).toMatchObject({
        reason: 'DISCONNECTION',
        disconnected: { teamLabel: 'B', seat: 0 },
        winnerTeamLabel: 'A',
      })
      a.close()
    })
  })

  describe('vencimiento global (S-10 a S-14, S-17)', () => {
    const atGlobalDeadline = async (roomId: string): Promise<void> => {
      // Nadie actua: se pierden turnos (30 s) hasta llegar a los 6 minutos.
      for (let elapsed = 0; elapsed < 330_000; elapsed += 30_000) {
        await advance(30_000)
      }

      await advance(29_999)
      expect((await document(roomId)).status).toBe('IN_BATTLE')
      await advance(1)
    }

    it('S-10/S-11/S-17: a 5:59.999 sigue; a 6:00.000 finaliza por TIME_LIMIT (porcentajes distintos, gana A)', async () => {
      maxHealthOf['sujeto-b'] = 50
      const { roomId, a, b } = await startedBattle()

      // Un golpe a B: A queda al 100 %, B al 88 %.
      hit()
      a.send(attack(roomId, 'cmd-golpe'))
      await a.waitFor('basicAttackResolved')
      await b?.waitFor('basicAttackResolved')

      await atGlobalDeadline(roomId)
      await a.waitFor('battleFinished')
      await b?.waitFor('battleFinished')

      expect(a.ofType('battleFinished')[0].result).toMatchObject({
        reason: 'TIME_LIMIT',
        outcome: 'WIN',
        winnerTeamLabel: 'A',
        tiebreak: 'LIFE_PERCENT',
      })
      a.close()
      b?.close()
    })

    it('S-12: mismo porcentaje y vida absoluta distinta -> gana la mayor (ABSOLUTE_LIFE)', async () => {
      const { roomId, a, b } = await startedBattle()

      await setHealth(roomId, [
        { teamLabel: 'A', seat: 0, current: 22, max: 44 },
        { teamLabel: 'B', seat: 0, current: 25, max: 50 },
      ])

      await atGlobalDeadline(roomId)
      await a.waitFor('battleFinished')

      expect(a.ofType('battleFinished')[0].result).toMatchObject({
        outcome: 'WIN',
        winnerTeamLabel: 'B',
        tiebreak: 'ABSOLUTE_LIFE',
      })
      expect(a.ofType('battleFinished')[0].result.teams).toMatchObject([
        { teamLabel: 'A', remainingHealth: 22, maxHealth: 44, lifePercent: 50 },
        { teamLabel: 'B', remainingHealth: 25, maxHealth: 50, lifePercent: 50 },
      ])
      a.close()
      b?.close()
    })

    it('S-13: mismo porcentaje y misma vida (nadie ataco) -> NO_WINNER', async () => {
      const { roomId, a, b } = await startedBattle()

      await atGlobalDeadline(roomId)
      await a.waitFor('battleFinished')

      expect(a.ofType('battleFinished')[0].result).toMatchObject({
        outcome: 'NO_WINNER',
        winnerTeamLabel: null,
        tiebreak: null,
      })
      expect(a.ofType('battleFinished')[0].result.participants.map((p: any) => p.result)).toEqual([
        'NO_WINNER',
        'NO_WINNER',
      ])
      a.close()
      b?.close()
    })

    it('S-14: la comparacion es ENTERA por producto cruzado (1/3 frente a 33/99)', async () => {
      const { roomId, a, b } = await startedBattle()

      await setHealth(roomId, [
        { teamLabel: 'A', seat: 0, current: 1, max: 3 },
        { teamLabel: 'B', seat: 0, current: 33, max: 99 },
      ])

      await atGlobalDeadline(roomId)
      await a.waitFor('battleFinished')

      expect(a.ofType('battleFinished')[0].result).toMatchObject({
        outcome: 'WIN',
        winnerTeamLabel: 'B',
        tiebreak: 'ABSOLUTE_LIFE',
      })
      a.close()
      b?.close()
    })
  })

  describe('turno de 30 s (S-15, S-16)', () => {
    it('S-15: a 29 999 ms sigue; a 30 000 ms `turnTimedOut`, avanza y el siguiente tiene 30 s nuevos', async () => {
      const { roomId, a, b } = await startedBattle()

      await advance(29_999)

      expect(a.ofType('turnTimedOut')).toHaveLength(0)

      await advance(1)
      await a.waitFor('turnTimedOut')
      await b?.waitFor('turnTimedOut')

      const timeout = a.ofType('turnTimedOut')[0]

      expect(timeout).toMatchObject({
        completedPosition: 0,
        timedOut: { teamLabel: 'A', seat: 0 },
      })
      expect(timeout.battle.currentTurn).toMatchObject({ teamLabel: 'B', seat: 0 })
      expect(timeout.battle.deadlines.turnEndsAt).toBe(
        new Date(clock.now().getTime() + 30_000).toISOString(),
      )
      expect((await document(roomId)).status).toBe('IN_BATTLE')

      a.close()
      b?.close()
    })

    it('S-16: un comando que llega tras el vencimiento y antes del barrido responde NOT_YOUR_TURN, sin sorteos', async () => {
      const { roomId, a, b } = await startedBattle()

      clock.advance(30_000)

      const used = sequence.used

      a.send(attack(roomId, 'cmd-tarde'))
      await a.waitFor('command.rejected')

      expect(a.ofType('command.rejected')[0]).toMatchObject({
        command: 'attack',
        code: 'NOT_YOUR_TURN',
      })
      expect(sequence.used).toBe(used)

      const after = await document(roomId)

      expect(after.events.at(-1).type).toBe('turnTimedOut')
      expect(after.battle.turnsCompleted).toBe(1)

      a.close()
      b?.close()
    })
  })

  describe('unicidad y carreras (S-18, S-19)', () => {
    /** Deja el reloj a 1 ms del vencimiento global, con el turno ya renovado. */
    const reachGlobalEdge = async (roomId: string): Promise<void> => {
      for (let elapsed = 0; elapsed < 330_000; elapsed += 30_000) {
        await advance(30_000)
      }

      await advance(29_999)
      expect((await document(roomId)).status).toBe('IN_BATTLE')
    }

    it('S-18: un comando y dos barridos con el vencimiento a la vez producen UN solo `battleFinished` y UNA notificacion', async () => {
      const { roomId, a, b } = await startedBattle()

      await reachGlobalEdge(roomId)

      // El comando y los barridos compiten por la sala; la liquidacion perezosa
      // puede decidir el vencimiento ANTES de sortear, asi que no se encolan
      // indices: lo que se demuestra es que solo hay UN resultado.
      clock.advance(1)

      a.send(attack(roomId, 'cmd-tardia'))

      await Promise.all([processDeadlines().execute(roomId), processDeadlines().execute(roomId)])
      await settle(300)

      await a.waitFor('battleFinished')
      await b?.waitFor('battleFinished')

      const after = await document(roomId)
      const mine = notifications.filter((notification) => notification.roomId === roomId)

      expect(after.events.filter((event: any) => event.type === 'battleFinished')).toHaveLength(1)
      expect(after.status).toBe('FINISHED')
      expect(after.result.reason).toBe('TIME_LIMIT')
      expect(mine).toHaveLength(1)

      a.close()
      b?.close()
    })

    it('S-18: dos barridos SIMULTANEOS sobre la misma sala vencida producen UN solo resultado', async () => {
      const { roomId, a, b } = await startedBattle()

      await reachGlobalEdge(roomId)

      clock.advance(1)

      await Promise.all([processDeadlines().execute(roomId), processDeadlines().execute(roomId)])
      await settle(300)

      await a.waitFor('battleFinished')

      const after = await document(roomId)

      expect(after.events.filter((event: any) => event.type === 'battleFinished')).toHaveLength(1)
      expect(notifications.filter((notification) => notification.roomId === roomId)).toHaveLength(1)
      expect(after.status).toBe('FINISHED')

      a.close()
      b?.close()
    })

    it('S-19: repetir el barrido sobre una sala FINISHED es no-op', async () => {
      maxHealthOf['sujeto-b'] = 5
      const { roomId, a, b } = await startedBattle()

      hit()
      a.send(attack(roomId, 'cmd-letal'))
      await a.waitFor('battleFinished')

      const afterFinish = await document(roomId)
      const notificationCount = notifications.filter(
        (notification) => notification.roomId === roomId,
      ).length

      await scheduler().tick()
      await scheduler().tick()
      await settle()

      expect(await document(roomId)).toEqual(afterFinish)
      expect(notifications.filter((notification) => notification.roomId === roomId)).toHaveLength(
        notificationCount,
      )

      a.close()
      b?.close()
    })
  })

  describe('recuperacion y liberacion (S-22 a S-25)', () => {
    it('S-22: un cliente nuevo recupera el resultado (`snapshot` con `result` o replay de `battleFinished`)', async () => {
      maxHealthOf['sujeto-b'] = 5
      const { roomId, a, b } = await startedBattle()

      hit()
      a.send(attack(roomId, 'cmd-letal'))
      await a.waitFor('battleFinished')

      const fresh = await connect('token-a')

      fresh.send({ type: 'resume', roomId })
      await fresh.waitFor('resume.ok')

      const snapshot = fresh.ofType('snapshot')[0]

      expect(snapshot).toMatchObject({
        status: 'FINISHED',
        result: { reason: 'ELIMINATION', outcome: 'WIN', winnerTeamLabel: 'A' },
      })

      const replayer = await connect('token-b')

      replayer.send({ type: 'resume', roomId, lastSeq: 1 })
      await replayer.waitFor('resume.ok')

      expect(replayer.ofType('battleFinished')).toHaveLength(1)
      expect(replayer.ofType('battleFinished')[0].result.reason).toBe('ELIMINATION')

      fresh.close()
      replayer.close()
      a.close()
      b?.close()
    })

    it('S-23: tras el final el chat de sala se cierra, la notificacion trae los creditos como derecho y la sala sale del planificador', async () => {
      maxHealthOf['sujeto-b'] = 5
      const { roomId, a, b } = await startedBattle()

      hit()
      a.send(attack(roomId, 'cmd-letal'))
      await a.waitFor('battleFinished')

      a.send({ type: 'chat.subscribe', channel: 'room', roomId })
      await a.waitFor('command.rejected')

      expect(a.ofType('command.rejected').at(-1)).toMatchObject({
        command: 'chat.subscribe',
        code: 'ROOM_NOT_ACTIVE',
      })

      expect(notifications.filter((notification) => notification.roomId === roomId)).toHaveLength(1)

      const mine = notifications.find((notification) => notification.roomId === roomId)

      expect(mine).toMatchObject({
        roomId,
        mode: 'PVP',
        reason: 'ELIMINATION',
        outcome: 'WIN',
        winnerTeamLabel: 'A',
        configuredReward: { amount: 10 },
      })
      expect(
        mine?.participants.map((participant) => ({
          teamLabel: participant.teamLabel,
          result: participant.result,
          credits: participant.credits,
        })),
      ).toEqual([
        { teamLabel: 'A', result: 'WON', credits: 2 },
        { teamLabel: 'B', result: 'LOST', credits: 1 },
      ])

      const farFuture = new Date(clock.now().getTime() + 10 * 60_000)

      expect(book().dueRooms(farFuture)).not.toContain(roomId)

      a.close()
      b?.close()
    })

    it('S-24: reiniciar Combat con una sala FINISHED la conserva con el mismo resultado', async () => {
      maxHealthOf['sujeto-b'] = 5
      const { roomId, a, b } = await startedBattle()

      hit()
      a.send(attack(roomId, 'cmd-letal'))
      await a.waitFor('battleFinished')

      const before = await document(roomId)

      a.close()
      b?.close()
      await app.close()

      clock = new MutableClock(new Date(clock.now().getTime() + 3_600_000))
      await boot(clock)

      expect(await document(roomId)).toEqual(before)

      const read = await call('GET', `/rooms/${roomId}`, 'token-a')

      expect(read.status).toBe(200)
      expect(read.body.status).toBe('FINISHED')
      expect(read.body.result).toEqual(before.result)
    })

    it('S-09: reiniciar con una sala IN_BATTLE siembra la gracia en el arranque y recupera el vencimiento global', async () => {
      const { roomId, a, b } = await startedBattle()

      a.close()
      b?.close()
      await app.close()

      // Solo 10 s despues del inicio: el global aun no vencio y la gracia del
      // arranque (30 s desde AHORA) es lo que decidira la frontera.
      clock = new MutableClock(new Date(clock.now().getTime() + 10_000))
      await boot(clock)

      // Nadie tiene conexion tras el arranque: la gracia corre desde AHORA.
      await advance(29_999)
      expect((await document(roomId)).status).toBe('IN_BATTLE')

      await advance(1)

      const after = await document(roomId)

      expect(after.status).toBe('FINISHED')
      expect(after.result.reason).toBe('DISCONNECTION')
    })

    it('S-25: una sala IN_BATTLE anterior a HU-21 y vencida se cierra en el primer barrido (con y sin Vida)', async () => {
      const withLife = await startedBattle()

      withLife.a.close()
      withLife.b?.close()

      const withoutLife = await startedBattle()

      withoutLife.a.close()
      withoutLife.b?.close()

      // A la primera se le quita `turnStartedAt` (anterior a HU-21) y a la segunda
      // tambien los combatientes (anterior a HU-18).
      await rooms().updateOne(
        { _id: withLife.roomId as never },
        {
          $set: { 'battle.startedAt': new Date('2026-09-20T10:00:00.000Z') },
          $unset: { 'battle.turnStartedAt': '' } as never,
        },
      )
      await rooms().updateOne(
        { _id: withoutLife.roomId as never },
        {
          $set: { 'battle.startedAt': new Date('2026-09-20T10:00:00.000Z') },
          $unset: { 'battle.turnStartedAt': '', 'battle.combatants': '' } as never,
        },
      )

      const now = clock.now()

      book().ensureDueBy(withLife.roomId, now)
      book().ensureDueBy(withoutLife.roomId, now)

      await scheduler().tick()
      await settle(200)
      // Cada barrido hace UNA transicion por sala; la segunda sala puede necesitar
      // una segunda pasada (turno vencido primero, global despues).
      book().ensureDueBy(withLife.roomId, now)
      book().ensureDueBy(withoutLife.roomId, now)
      await scheduler().tick()
      await settle(200)

      const first = await document(withLife.roomId)

      expect(first.status).toBe('FINISHED')
      expect(first.result.reason).toBe('TIME_LIMIT')

      const second = await document(withoutLife.roomId)

      expect(second.status).toBe('FINISHED')
      expect(second.result).toMatchObject({ reason: 'TIME_LIMIT', outcome: 'NO_WINNER' })
    })
  })

  describe('migracion 009', () => {
    it('acepta lo nuevo (FINISHED, result, turnStartedAt y eventos) y rechaza estados, eventos y resultados invalidos', async () => {
      maxHealthOf['sujeto-b'] = 5
      const { roomId, a, b } = await startedBattle()

      hit()
      a.send(attack(roomId, 'cmd-letal'))
      await a.waitFor('battleFinished')

      const finished = await document(roomId)

      expect(finished.status).toBe('FINISHED')
      expect(finished.result.reason).toBe('ELIMINATION')
      expect(finished.events.at(-1).type).toBe('battleFinished')

      let copia = 0
      const clone = async (override: Record<string, unknown>): Promise<void> => {
        copia += 1

        await rooms().insertOne({
          ...finished,
          _id: `copia-${String(copia)}`,
          ...override,
        } as never)
      }

      await expect(clone({ status: 'DESCONOCIDA' })).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        clone({
          events: [
            ...finished.events.slice(0, -1),
            { ...finished.events.at(-1), type: 'battleExploded' },
          ],
        }),
      ).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        clone({ result: { ...finished.result, reason: 'SURRENDER' } }),
      ).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        clone({ result: { ...finished.result, outcome: 'DRAW' } }),
      ).rejects.toBeInstanceOf(MongoServerError)

      a.close()
      b?.close()
    })

    it('su `down` vuelve al validador de 008 (rechaza FINISHED) y su `up` lo restablece', async () => {
      maxHealthOf['sujeto-b'] = 5
      const { roomId, a, b } = await startedBattle()

      hit()
      a.send(attack(roomId, 'cmd-letal'))
      await a.waitFor('battleFinished')

      const finished = await document(roomId)

      await downFinishMigration(db)

      try {
        await expect(
          rooms().insertOne({ ...finished, _id: 'copia-down', status: 'FINISHED' } as never),
        ).rejects.toBeInstanceOf(MongoServerError)
      } finally {
        await upFinishMigration(db)
        await upSkillEffectsMigration(db)
      }

      await expect(
        rooms().insertOne({ ...finished, _id: 'copia-up' } as never),
      ).resolves.toMatchObject({
        acknowledged: true,
      })

      a.close()
      b?.close()
    })
  })

  it('al terminar no quedan sorteos sin consumir: ningun test dejo la secuencia guionizada con indices de mas', () => {
    expect(sequence.pending()).toBe(0)
  })
})
