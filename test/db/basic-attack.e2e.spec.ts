/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-type-assertion -- las respuestas y eventos del servidor real (HTTP, WebSocket y MongoDB) son JSON dinamico; el contrato se verifica con las aserciones, no con tipos */
import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { type Db, type MongoClient, MongoServerError } from 'mongodb'
import { WebSocket } from 'ws'

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
import { indexForEffect, indexForFace } from '../fixtures/basic-attack'
import { equippedHeroFixture } from '../fixtures/equipped-hero'

/**
 * VALIDACION INTEGRADA DE HU-18 (Task #412) a nivel de PROTOCOLO, sin dobles del
 * transporte ni de la base: MongoDB REAL (Testcontainers), servidor Nest REAL y DOS
 * clientes WebSocket REALES (`ws`), cada uno con su propio `sub`, ticket y conexion.
 *
 * Solo se sustituyen las fronteras EXTERNAS a Combat: el JWT de Cognito, Account y
 * Player-Inventory, y la SECUENCIA HU-24 (por una guionizada), para que cada resultado
 * sea conocido y ningun test dependa del azar. Todo lo demas -- HU-20, HU-25, el dominio,
 * la persistencia y el gateway -- es el real.
 *
 * Heroes: Guerrero Armas de la Tabla 6 sin equipamiento (Vida 44, Ataque 10 + 1d6,
 * Defensa 11, Dano 1d6). Con Defensa 11, la cara 1 iguala (NO supera).
 */
const SUBJECTS: Readonly<Record<string, string>> = {
  'token-a': 'sujeto-a',
  'token-b': 'sujeto-b',
  'token-c': 'sujeto-c',
  'token-d': 'sujeto-d',
  'token-e': 'sujeto-e',
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

/** Cuenta cuantas veces se consulta Player-Inventory: debe ser UNA por jugador y solo al iniciar. */
const inventoryCalls: string[] = []

/**
 * HU-19 amplio la vista de cada combatiente con `power` y `skills`. Los tests de HU-18 comprueban la
 * Vida y el turno, asi que se proyecta lo que HU-18 publica; la forma completa (y su hermetismo) la
 * cubre el test de privacidad de este archivo y `skills.e2e.spec.ts`.
 */
const lifeOf = (combatants: readonly any[]): unknown[] =>
  combatants.map(({ teamLabel, seat, health }) => ({ teamLabel, seat, health }))

const armasHero = (playerId: string): EquippedHero =>
  equippedHeroFixture({
    playerId,
    heroId: `heroe-de-${playerId}`,
    subtype: 'GUERRERO_ARMAS',
    loadoutVersion: 0,
    activeEffects: [],
    effectiveStats: {
      power: 10,
      health: 44,
      defense: 11,
      attack: 10,
      damage: { mode: 'DICE', count: 1, sides: 6 },
      healing: null,
    },
  })

const heroes: PlayerInventoryEquippedHeroPort = {
  getEquippedHero: (playerId) => {
    inventoryCalls.push(playerId)

    return Promise.resolve(armasHero(playerId))
  },
}

/**
 * Secuencia HU-24 guionizada: los indices se ENCOLAN justo antes de cada accion. Si el
 * servidor sortea de mas, lanza (un sorteo inesperado rompe el test); si sortea de
 * menos, `pending()` no es 0 y el test lo detecta.
 */
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

/** Cliente WebSocket con su bandeja de mensajes. */
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

      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    throw new Error(
      `No llego ${String(count)} mensaje(s) "${type}" en ${String(timeoutMs)} ms: ${this.raw.join(' | ')}`,
    )
  }

  async waitClose(timeoutMs = 8_000): Promise<number> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.closes.length > 0) {
        return this.closes[0] ?? -1
      }

      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    throw new Error('La conexion no se cerro a tiempo')
  }

  close(): void {
    this.ws.close()
  }
}

describe('HU-18 de extremo a extremo (protocolo): ataque basico entre dos clientes WebSocket reales, Combat y MongoDB', () => {
  let container: StartedMongoDBContainer
  let mongo: MongoClient
  let db: Db
  let mongoUri: string
  let app: INestApplication
  let port: number
  let restoreEnv: () => void
  const sequence = new ScriptedQueue()

  const boot = async (): Promise<void> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(ACCOUNT_BATTLE_PROFILE)
      .useValue(accounts)
      .overrideProvider(PLAYER_INVENTORY_EQUIPPED_HERO)
      .useValue(heroes)
      .overrideProvider(BATTLE_RANDOM_SEQUENCE)
      .useValue(sequence)
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

    await boot()
  }, 180_000)

  afterAll(async () => {
    await app.close()
    await mongo.close()
    await container.stop()
    restoreEnv()
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

  const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** Sala 1v1 preparada: `token-a` (equipo A, creador) contra `token-b` (equipo B). */
  const preparingRoom = async (): Promise<string> => {
    const created = await call('POST', '/rooms', 'token-a', {
      mode: 'PVP',
      teamConfigs: [{ capacity: 1, initialParticipants: [{ kind: 'HUMAN' }] }, { capacity: 1 }],
      reward: { amount: 0 },
    })

    expect(created.status).toBe(201)

    const joined = await call('POST', `/rooms/${created.body.id as string}/join`, 'token-b', {})

    expect(joined.body.status).toBe('PREPARING')

    return created.body.id as string
  }

  /** Batalla 1v1 iniciada, con los dos clientes ya suscritos. El equipo A abre (indice 1 -> equipo inicial 0). */
  const startedBattle = async () => {
    const roomId = await preparingRoom()
    const a = await connect('token-a')
    const b = await connect('token-b')

    a.send({ type: 'resume', roomId })
    b.send({ type: 'resume', roomId })
    await a.waitFor('resume.ok')
    await b.waitFor('resume.ok')

    sequence.push(1)
    const started = await call('POST', `/rooms/${roomId}/start`, 'token-a')

    expect(started.status).toBe(200)
    await a.waitFor('battleStarted')
    await b.waitFor('battleStarted')
    expect(started.body.battle.currentTurn.playerId).toBe('sujeto-a')
    expect(sequence.pending()).toBe(0)

    return { roomId, a, b }
  }

  const attack = (
    roomId: string,
    commandId: string,
    target: unknown = { teamLabel: 'B', seat: 0 },
  ): Record<string, unknown> => ({ type: 'attack', commandId, roomId, target })

  const document = async (roomId: string): Promise<Record<string, any>> => {
    const found = await db
      .collection<Record<string, any>>('battle-rooms')
      .findOne({ _id: roomId as never })

    if (found === null) {
      throw new Error('la sala no esta en MongoDB')
    }

    return found
  }

  const face = (value: number, sides = 6): number => indexForFace(value, sides)
  const effect = (kind: RandomEffectType, percent?: number): number =>
    indexForEffect('GUERRERO_ARMAS', kind, percent)

  describe('flujo principal 1v1 (CA-01, CA-05, CA-06, CA-07)', () => {
    let roomId: string
    let a: Client
    let b: Client
    let before: Record<string, any>

    beforeAll(async () => {
      ;({ roomId, a, b } = await startedBattle())
      before = await document(roomId)
    })

    afterAll(() => {
      a.close()
      b.close()
    })

    it('la Vida inicial sale del snapshot congelado: 44 / 44 para los dos, sin volver a Player-Inventory', () => {
      const started = a.ofType('battleStarted')[0] as any

      expect(lifeOf(started.battle.combatants)).toEqual([
        { teamLabel: 'A', seat: 0, health: { current: 44, max: 44 } },
        { teamLabel: 'B', seat: 0, health: { current: 44, max: 44 } },
      ])
      expect(before.battle.combatants).toHaveLength(2)
      expect(before.battle.combatants[0].profile).toMatchObject({ maxHealth: 44, defense: 11 })
    })

    it('CRITICO 137 %: ataque -> resolucion -> Vida -> fin de turno, y AMBOS clientes reciben LOS MISMOS bytes', async () => {
      const callsBefore = inventoryCalls.length
      const usedBefore = sequence.used

      // Dado de Ataque 5 (10 + 5 = 15 > 11), critico 137 %, dado de Dano 5: floor(5 x 1,37) = 6.
      sequence.push(face(5), effect(RandomEffectType.CriticalDamage, 137), face(5))
      a.send(attack(roomId, 'cmd-critico'))

      const [eventA] = await a.waitFor('basicAttackResolved')
      const [eventB] = await b.waitFor('basicAttackResolved')

      expect(a.raw.find((text) => text.includes('basicAttackResolved'))).toBe(
        b.raw.find((text) => text.includes('basicAttackResolved')),
      )
      expect(eventA).toEqual(eventB)
      expect(eventA).toMatchObject({
        type: 'basicAttackResolved',
        seq: 2,
        roomId,
        commandId: 'cmd-critico',
        completedPosition: 0,
        attacker: { teamLabel: 'A', seat: 0 },
        target: { teamLabel: 'B', seat: 0 },
        resolution: {
          attackValue: 15,
          defenseValue: 11,
          effective: true,
          effect: 'CRITICAL_DAMAGE',
          percent: 137,
          baseDamage: 5,
          calculatedDamage: 6,
          appliedDamage: 6,
        },
        targetHealth: { before: 44, after: 38 },
      })
      expect(lifeOf(eventA.battle.combatants)).toEqual([
        { teamLabel: 'A', seat: 0, health: { current: 44, max: 44 } },
        { teamLabel: 'B', seat: 0, health: { current: 38, max: 44 } },
      ])
      expect(eventA.battle.turnsCompleted).toBe(1)
      expect(eventA.battle.currentTurn).toMatchObject({ teamLabel: 'B', playerId: 'sujeto-b' })
      // Exactamente los 3 sorteos del orden documentado y nada mas.
      expect(sequence.used - usedBefore).toBe(3)
      expect(sequence.pending()).toBe(0)
      // Ninguna llamada a Player-Inventory por golpe.
      expect(inventoryCalls).toHaveLength(callsBefore)
    })

    it('MongoDB: Vida, evento, commandId y turno cambiaron JUNTOS en UNA version nueva', async () => {
      const after = await document(roomId)

      expect(Number(after.version)).toBe(Number(before.version) + 1)
      expect(after.battle.turnsCompleted).toBe(1)
      expect(after.battle.combatants[1].currentHealth).toBe(38)
      expect(after.battle.combatants[0].currentHealth).toBe(44)
      expect(after.events.map((event: any) => [event.seq, event.type])).toEqual([
        [1, 'battleStarted'],
        [2, 'basicAttackResolved'],
      ])
      expect(after.handledCommands).toEqual([{ commandId: 'cmd-critico', seq: 2 }])
    })

    it('el estado HTTP coincide con el ultimo evento y con lo persistido', async () => {
      const room = await call('GET', `/rooms/${roomId}`, 'token-b')
      const event = a.ofType('basicAttackResolved')[0] as any

      expect(room.body.lastSeq).toBe(2)
      expect(room.body.battle).toEqual(event.battle)
    })

    it('el mensaje no contiene semilla, indices, estadisticas ni efectos; el Poder solo con la forma que publica HU-19', () => {
      const raw = a.raw.join('\n')

      // HU-19 publica el Poder y las habilidades de cada combatiente (HU-11: medidor de Poder), asi
      // que `power` ya no esta prohibido: lo que sigue vetado es todo lo demas.
      expect(raw).not.toMatch(
        /seed|semilla|mt19937|activeEffects|jwt|ticket|maxHealth|"defense"|"damage"/i,
      )

      const started = a.ofType('battleStarted')[0] as any

      for (const combatant of started.battle.combatants) {
        expect(Object.keys(combatant).sort()).toEqual([
          'health',
          'power',
          'seat',
          'skills',
          'teamLabel',
        ])
        expect(Object.keys(combatant.power).sort()).toEqual(['current', 'max'])

        for (const skill of combatant.skills) {
          expect(Object.keys(skill).sort()).toEqual([
            'abilityId',
            'chargeTurns',
            'cooldownRemaining',
            'name',
            'powerCost',
            'status',
          ])
        }
      }
    })

    it('IDEMPOTENCIA: repetir el MISMO commandId devuelve el mismo evento solo a quien lo repite, sin sorteos ni dano', async () => {
      const usedBefore = sequence.used
      const original = a.raw.find((text) => text.includes('basicAttackResolved'))
      const bBefore = b.raw.length
      const versionBefore = Number((await document(roomId)).version)

      a.send(attack(roomId, 'cmd-critico'))
      await a.waitFor('basicAttackResolved', 2)
      await settle()

      expect(a.raw.filter((text) => text === original)).toHaveLength(2)
      expect(b.raw).toHaveLength(bBefore)
      expect(sequence.used).toBe(usedBefore)
      const after = await document(roomId)

      expect(Number(after.version)).toBe(versionBefore)
      expect(after.events).toHaveLength(2)
      expect(after.battle.combatants[1].currentHealth).toBe(38)
      expect(after.battle.turnsCompleted).toBe(1)
    })

    it('FUERA DE TURNO: quien ya ataco no puede volver a hacerlo; el rechazo llega solo a el y nada cambia', async () => {
      const usedBefore = sequence.used
      const bBefore = b.raw.length

      a.send(attack(roomId, 'cmd-otra-vez'))
      const [rejection] = await a.waitFor('command.rejected')

      expect(rejection).toEqual({
        type: 'command.rejected',
        command: 'attack',
        commandId: 'cmd-otra-vez',
        code: 'NOT_YOUR_TURN',
      })
      await settle()
      expect(b.raw).toHaveLength(bBefore)
      expect(sequence.used).toBe(usedBefore)
      expect((await document(roomId)).events).toHaveLength(2)
    })

    it('EFECTO 0 %: el rival responde, la Vida no cambia y el turno vuelve al primero (ronda 2)', async () => {
      const usedBefore = sequence.used

      sequence.push(face(4), effect(RandomEffectType.NoDamage))
      b.send(attack(roomId, 'cmd-cero', { teamLabel: 'A', seat: 0 }))

      // `b` recibio el critico y este; `a` ademas recibio la repeticion del critico (idempotencia).
      const events = await b.waitFor('basicAttackResolved', 2)
      const zero = events[1] as any

      expect(zero).toMatchObject({
        seq: 3,
        attacker: { teamLabel: 'B', seat: 0 },
        target: { teamLabel: 'A', seat: 0 },
        resolution: {
          effective: true,
          effect: 'NO_DAMAGE',
          percent: 0,
          baseDamage: null,
          calculatedDamage: 0,
          appliedDamage: 0,
        },
        targetHealth: { before: 44, after: 44 },
      })
      expect(zero.battle.currentTurn).toMatchObject({ teamLabel: 'A' })
      expect(zero.battle.round).toBe(2)
      // Sin dado de Dano: solo Ataque + efecto.
      expect(sequence.used - usedBefore).toBe(2)
      expect(sequence.pending()).toBe(0)
    })

    it('GOLPE NO EFECTIVO: Ataque = Defensa no supera; Vida igual; el turno SI avanza; solo se consume el dado de Ataque', async () => {
      const usedBefore = sequence.used

      // Cara 1: 10 + 1 = 11, igual a la Defensa 11.
      sequence.push(face(1))
      a.send(attack(roomId, 'cmd-fallo'))

      const events = await b.waitFor('basicAttackResolved', 3)
      const miss = events[2] as any

      expect(miss).toMatchObject({
        seq: 4,
        resolution: {
          attackValue: 11,
          defenseValue: 11,
          effective: false,
          effect: null,
          percent: null,
          baseDamage: null,
          calculatedDamage: 0,
          appliedDamage: 0,
        },
        targetHealth: { before: 38, after: 38 },
      })
      expect(miss.battle.currentTurn).toMatchObject({ teamLabel: 'B' })
      expect(sequence.used - usedBefore).toBe(1)
      expect(sequence.pending()).toBe(0)
    })

    it('DOS CLIENTES: terminan con el mismo seq, la misma Vida y el mismo turno', async () => {
      const room = await call('GET', `/rooms/${roomId}`, 'token-a')
      const lastA = a.ofType('basicAttackResolved').at(-1) as any
      const lastB = b.ofType('basicAttackResolved').at(-1) as any

      expect(lastA).toEqual(lastB)
      expect(lastA.seq).toBe(4)
      expect(room.body.lastSeq).toBe(4)
      expect(room.body.battle).toEqual(lastA.battle)
      expect(room.body.battle.combatants.map((c: any) => c.health.current)).toEqual([44, 38])
    })

    it('los rechazos de validacion no consumen sorteos ni cambian el estado', async () => {
      const usedBefore = sequence.used
      const versionBefore = Number((await document(roomId)).version)

      // Es el turno de B. Se prueban rechazos desde B (su turno) y desde A (fuera de turno).
      const cases: [Client, Record<string, unknown>, string][] = [
        [b, attack(roomId, 'r1', { teamLabel: 'Z', seat: 9 }), 'INVALID_TARGET'],
        [b, attack(roomId, 'r2', { teamLabel: 'B', seat: 0 }), 'SAME_TEAM_TARGET'],
        [b, { ...attack(roomId, 'r3'), attackValue: 99 }, 'MALFORMED_COMMAND'],
        [b, { ...attack(roomId, 'r4'), damage: 99 }, 'MALFORMED_COMMAND'],
        [
          b,
          { ...attack(roomId, 'r5'), targets: [{ teamLabel: 'A', seat: 0 }] },
          'MALFORMED_COMMAND',
        ],
        [
          b,
          { type: 'attack', commandId: 'r6', roomId, target: [{ teamLabel: 'A', seat: 0 }] },
          'MALFORMED_COMMAND',
        ],
        [b, attack(roomId, '', { teamLabel: 'A', seat: 0 }), 'INVALID_COMMAND_ID'],
        [a, attack(roomId, 'r7', { teamLabel: 'B', seat: 0 }), 'NOT_YOUR_TURN'],
      ]

      for (const [client, message, code] of cases) {
        const count = client.ofType('command.rejected').length

        client.send(message)
        await client.waitFor('command.rejected', count + 1)

        expect(client.ofType('command.rejected').at(-1)).toMatchObject({ command: 'attack', code })
      }

      expect(sequence.used).toBe(usedBefore)
      expect(Number((await document(roomId)).version)).toBe(versionBefore)
    })

    it('un jugador AJENO a la sala no puede atacar (NOT_A_PARTICIPANT) ni recibe los eventos', async () => {
      const c = await connect('token-c')

      c.send(attack(roomId, 'intruso'))
      const [rejection] = await c.waitFor('command.rejected')

      expect(rejection).toMatchObject({ code: 'NOT_A_PARTICIPANT', command: 'attack' })
      expect(c.ofType('basicAttackResolved')).toEqual([])
      c.close()
    })
  })

  describe('desconexion, recarga y reinicio: el resultado persistido se recupera EXACTO', () => {
    it('RECONEXION: si B se cae y A ataca, al volver B recibe el ataque por resume con la Vida y el turno correctos', async () => {
      const { roomId, a, b } = await startedBattle()

      b.close()
      await b.waitClose()

      sequence.push(face(5), effect(RandomEffectType.Damage), face(4))
      a.send(attack(roomId, 'cmd-mientras-cae'))
      await a.waitFor('basicAttackResolved')

      const back = await connect('token-b')

      back.send({ type: 'resume', roomId, lastSeq: 1 })
      await back.waitFor('resume.ok')

      const [replayed] = back.ofType('basicAttackResolved')

      expect(back.ofType('snapshot')).toEqual([])
      expect(replayed).toEqual(a.ofType('basicAttackResolved')[0])
      expect(replayed.targetHealth).toEqual({ before: 44, after: 40 })
      expect(replayed.battle.currentTurn).toMatchObject({ playerId: 'sujeto-b' })
      expect(sequence.pending()).toBe(0)
      a.close()
      back.close()
    })

    it('RECARGA (resume sin lastSeq): el snapshot trae la Vida actual y el turno vigente', async () => {
      const { roomId, a, b } = await startedBattle()

      sequence.push(face(6), effect(RandomEffectType.Damage), face(3))
      a.send(attack(roomId, 'cmd-recarga'))
      await b.waitFor('basicAttackResolved')

      const refreshed = await connect('token-b')

      refreshed.send({ type: 'resume', roomId })
      await refreshed.waitFor('resume.ok')

      const [snapshot] = refreshed.ofType('snapshot')
      const room = await call('GET', `/rooms/${roomId}`, 'token-b')

      expect(snapshot).toMatchObject({ roomId, seq: 2, status: 'IN_BATTLE' })
      expect(lifeOf(snapshot.battle.combatants)).toEqual([
        { teamLabel: 'A', seat: 0, health: { current: 44, max: 44 } },
        { teamLabel: 'B', seat: 0, health: { current: 41, max: 44 } },
      ])
      expect(snapshot.battle.currentTurn).toMatchObject({ playerId: 'sujeto-b' })
      expect(snapshot.battle).toEqual(room.body.battle)
      a.close()
      b.close()
      refreshed.close()
    })

    it('REINICIO de Combat: el estado sobrevive, resume lo reproduce y el combate continua desde la Vida guardada', async () => {
      const { roomId, a, b } = await startedBattle()

      sequence.push(face(5), effect(RandomEffectType.Damage), face(4))
      a.send(attack(roomId, 'cmd-antes-del-reinicio'))
      await a.waitFor('basicAttackResolved')
      const persisted = (await document(roomId)).battle
      a.close()
      b.close()

      await app.close()
      await boot()

      const b2 = await connect('token-b')

      b2.send({ type: 'resume', roomId, lastSeq: 1 })
      await b2.waitFor('resume.ok')

      expect(b2.ofType('basicAttackResolved')[0].targetHealth).toEqual({ before: 44, after: 40 })
      expect(persisted.combatants[1].currentHealth).toBe(40)

      // Y el rival responde desde la Vida que quedo en MongoDB.
      sequence.push(face(5), effect(RandomEffectType.Damage), face(2))
      b2.send(attack(roomId, 'cmd-despues-del-reinicio', { teamLabel: 'A', seat: 0 }))
      const events = await b2.waitFor('basicAttackResolved', 2)

      expect(events[1]).toMatchObject({ seq: 3, targetHealth: { before: 44, after: 42 } })
      expect(events[1].battle.combatants.map((c: any) => c.health.current)).toEqual([42, 40])
      b2.close()
    }, 60_000)
  })

  describe('concurrencia real: dos pestanas del mismo jugador', () => {
    it('DOS comandos DISTINTOS a la vez: solo UNO muta la batalla; el otro NOT_YOUR_TURN sin sorteos', async () => {
      const { roomId, a, b } = await startedBattle()
      const pestana = await connect('token-a')

      pestana.send({ type: 'resume', roomId })
      await pestana.waitFor('resume.ok')

      sequence.push(face(5), effect(RandomEffectType.Damage), face(4))
      const usedBefore = sequence.used

      a.send(attack(roomId, 'cmd-x'))
      pestana.send(attack(roomId, 'cmd-y'))
      await settle(600)

      const resolved = [
        ...a.ofType('basicAttackResolved'),
        ...pestana.ofType('basicAttackResolved'),
      ]
      const rejected = [...a.ofType('command.rejected'), ...pestana.ofType('command.rejected')]

      expect(new Set(resolved.map((event) => event.seq))).toEqual(new Set([2]))
      expect(rejected).toHaveLength(1)
      expect(rejected[0]).toMatchObject({ code: 'NOT_YOUR_TURN' })
      expect(sequence.used - usedBefore).toBe(3)
      expect(sequence.pending()).toBe(0)

      const doc = await document(roomId)

      expect(doc.events).toHaveLength(2)
      expect(doc.handledCommands).toHaveLength(1)
      expect(doc.battle.combatants[1].currentHealth).toBe(40)
      expect(doc.battle.turnsCompleted).toBe(1)
      a.close()
      b.close()
      pestana.close()
    })

    it('el MISMO commandId a la vez (doble clic): una ejecucion y una repeticion, un solo dano', async () => {
      const { roomId, a, b } = await startedBattle()
      const pestana = await connect('token-a')

      pestana.send({ type: 'resume', roomId })
      await pestana.waitFor('resume.ok')

      sequence.push(face(5), effect(RandomEffectType.Damage), face(4))
      const usedBefore = sequence.used

      a.send(attack(roomId, 'cmd-doble'))
      pestana.send(attack(roomId, 'cmd-doble'))
      await settle(600)

      expect(sequence.used - usedBefore).toBe(3)
      expect(a.ofType('command.rejected')).toEqual([])
      expect(pestana.ofType('command.rejected')).toEqual([])

      const doc = await document(roomId)

      expect(doc.events).toHaveLength(2)
      expect(doc.battle.combatants[1].currentHealth).toBe(40)
      expect(doc.battle.turnsCompleted).toBe(1)
      a.close()
      b.close()
      pestana.close()
    })
  })

  describe('objetivo unico en equipos (2v2)', () => {
    it('elegir a UN rival cambia solo su Vida; un aliado se rechaza', async () => {
      const created = await call('POST', '/rooms', 'token-a', {
        mode: 'PVP',
        teamConfigs: [{ capacity: 2, initialParticipants: [{ kind: 'HUMAN' }] }, { capacity: 2 }],
        reward: { amount: 0 },
      })
      const roomId = created.body.id as string

      for (const [token, team] of [
        ['token-d', 'A'],
        ['token-b', 'B'],
        ['token-e', 'B'],
      ] as const) {
        const joined = await call('POST', `/rooms/${roomId}/join`, token, { team })

        expect(joined.status).toBe(200)
      }

      const clients = await Promise.all(['token-a', 'token-b', 'token-d', 'token-e'].map(connect))

      for (const client of clients) {
        client.send({ type: 'resume', roomId })
      }
      await Promise.all(clients.map((client) => client.waitFor('resume.ok')))

      // Indice de equipo inicial y un intercambio por equipo (2 integrantes cada uno).
      sequence.push(1, 2, 2)
      const started = await call('POST', `/rooms/${roomId}/start`, 'token-a')

      expect(started.status).toBe(200)
      await Promise.all(clients.map((client) => client.waitFor('battleStarted')))

      const current = started.body.battle.currentTurn as { playerId: string; teamLabel: string }
      const tokenOf = (playerId: string): string => `token-${playerId.replace('sujeto-', '')}`
      const actor =
        clients[['token-a', 'token-b', 'token-d', 'token-e'].indexOf(tokenOf(current.playerId))]
      const rivalTeam = current.teamLabel === 'A' ? 'B' : 'A'

      if (actor === undefined) {
        throw new Error('no se encontro al jugador con el turno')
      }

      // Un aliado (mismo equipo, otro asiento) se rechaza antes de sortear.
      const usedBefore = sequence.used

      actor.send(attack(roomId, 'aliado', { teamLabel: current.teamLabel, seat: 1 }))
      await actor.waitFor('command.rejected')
      expect(actor.ofType('command.rejected').at(-1)).toMatchObject({ code: 'SAME_TEAM_TARGET' })
      expect(sequence.used).toBe(usedBefore)

      // Un rival concreto: solo su Vida cambia.
      sequence.push(face(5), effect(RandomEffectType.Damage), face(4))
      actor.send(attack(roomId, 'rival', { teamLabel: rivalTeam, seat: 1 }))
      const [event] = await actor.waitFor('basicAttackResolved')
      const health = Object.fromEntries(
        event.battle.combatants.map((c: any) => [
          `${c.teamLabel}#${String(c.seat)}`,
          c.health.current,
        ]),
      )

      expect(health[`${rivalTeam}#1`]).toBe(40)
      expect(health[`${rivalTeam}#0`]).toBe(44)
      expect(health[`${current.teamLabel}#0`]).toBe(44)
      expect(health[`${current.teamLabel}#1`]).toBe(44)

      for (const client of clients) {
        client.close()
      }
    }, 60_000)
  })

  describe('batallas anteriores a HU-18 y migracion 007', () => {
    it('una batalla IN_BATTLE de HU-17 (sin combatants) se restaura, no admite ataque y su snapshot no trae Vida', async () => {
      const roomId = await preparingRoom()
      const room = await document(roomId)
      const turnOrder = room.teams.flatMap((team: any) =>
        team.participants.map((participant: any, seat: number) => ({
          teamLabel: team.label,
          seat,
          kind: participant.kind,
          playerId: participant.playerId,
          displayName: participant.displayName ?? null,
          heroId: participant.heroId,
          heroSubtype: 'GUERRERO_ARMAS',
        })),
      )
      const view = {
        battleId: roomId,
        startedAt: new Date('2026-09-20T10:00:00.000Z').toISOString(),
        turnOrder: turnOrder.map((entry: any, position: number) => ({ position, ...entry })),
        turnsCompleted: 0,
        round: 1,
        currentTurn: { position: 0, ...turnOrder[0] },
      }

      // Documento escrito por HU-17: batalla y evento SIN `combatants`.
      await db.collection('battle-rooms').updateOne(
        { _id: roomId as never },
        {
          $set: {
            status: 'IN_BATTLE',
            battle: {
              startedAt: new Date('2026-09-20T10:00:00.000Z'),
              turnOrder,
              turnsCompleted: 0,
            },
            events: [
              {
                seq: 1,
                type: 'battleStarted',
                occurredAt: new Date('2026-09-20T10:00:00.000Z'),
                payload: { battle: view },
              },
            ],
            handledCommands: [],
          },
        },
      )

      const a = await connect('token-a')

      a.send({ type: 'resume', roomId })
      await a.waitFor('resume.ok')
      expect(a.ofType('snapshot')[0].battle.combatants).toEqual([])

      const usedBefore = sequence.used

      a.send(attack(roomId, 'legacy', { teamLabel: 'B', seat: 0 }))
      const [rejection] = await a.waitFor('command.rejected')

      expect(rejection).toMatchObject({ code: 'UNSUPPORTED_COMBAT_PROFILE', command: 'attack' })
      expect(sequence.used).toBe(usedBefore)
      expect((await document(roomId)).battle).not.toHaveProperty('combatants')
      a.close()
    })

    it('el validador de la migracion 007 acepta el evento nuevo y rechaza una Vida negativa o un campo desconocido', async () => {
      const { roomId, a, b } = await startedBattle()
      const collection = db.collection<Record<string, any>>('battle-rooms')

      await expect(
        collection.updateOne(
          { _id: roomId as never },
          { $set: { 'battle.combatants.0.currentHealth': -1 } },
        ),
      ).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        collection.updateOne(
          { _id: roomId as never },
          { $set: { 'battle.combatants.0.inventario': {} } },
        ),
      ).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        collection.updateOne({ _id: roomId as never }, {
          $push: {
            events: { seq: 2, type: 'tipo-inventado', occurredAt: new Date(), payload: {} },
          },
        } as never),
      ).rejects.toBeInstanceOf(MongoServerError)

      // El flujo real escribe el evento `basicAttackResolved` sin objecion del validador.
      sequence.push(face(5), effect(RandomEffectType.Damage), face(4))
      a.send(attack(roomId, 'cmd-validador'))
      await a.waitFor('basicAttackResolved')
      expect((await document(roomId)).events.at(-1).type).toBe('basicAttackResolved')
      a.close()
      b.close()
    })
  })

  it('al terminar no quedan sorteos sin consumir: ningun test dejo la secuencia guionizada con indices de mas', () => {
    expect(sequence.pending()).toBe(0)
  })
})
