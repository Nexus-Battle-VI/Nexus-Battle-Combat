/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion -- las respuestas y eventos del servidor real (HTTP, WebSocket y MongoDB) son JSON dinamico; el contrato se verifica con las aserciones, no con tipos */
import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { type Db, type MongoClient, MongoServerError } from 'mongodb'
import { WebSocket } from 'ws'

import { BATTLE_RANDOM_SEQUENCE } from '../../src/adapters/inbound/http/tokens'
import {
  down as downSkillsMigration,
  up as upSkillsMigration,
} from '../../src/adapters/outbound/persistence/migrations/008-battle-rooms-skills'
import { up as upFinishMigration } from '../../src/adapters/outbound/persistence/migrations/009-battle-rooms-finish'
import {
  ACCOUNT_BATTLE_PROFILE,
  type AccountBattleProfilePort,
} from '../../src/application/ports/AccountBattleProfilePort'
import {
  PLAYER_INVENTORY_EQUIPPED_HERO,
  type EquippedHero,
  type EquippedHeroAbility,
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
import {
  equippedHeroFixture,
  shieldStrikeAbility,
  stoneHandAbility,
} from '../fixtures/equipped-hero'
import { STORM_ID } from '../fixtures/skills'

/**
 * VALIDACION DE HU-19 (Task #414/#416) a nivel de PROTOCOLO, sin dobles del transporte ni de
 * la base: MongoDB REAL (Testcontainers), servidor Nest REAL y DOS clientes WebSocket REALES
 * (`ws`), cada uno con su propio `sub`, ticket y conexion.
 *
 * Solo se sustituyen las fronteras EXTERNAS a Combat: el JWT de Cognito, Account y
 * Player-Inventory, y la SECUENCIA HU-24 (por una guionizada), para que cada resultado sea
 * conocido y ningun test dependa del azar. Todo lo demas -- HU-20, HU-25, el dominio, la
 * persistencia, la migracion 008 y el gateway -- es el real.
 *
 * ESTO NO ES LA VALIDACION INTEGRADA CON Player-Inventory NI Catalog REALES (Task #416 la pide
 * sin mocks): aqui Player-Inventory es un doble que publica el contrato `equipped-hero` con
 * `abilities`. Esa evidencia exige el sistema desplegado en orden.
 *
 * Heroes: Guerrero Armas de la Tabla 6 (Vida 44, Ataque 10 + 1d6, Defensa 11, Dano 1d6), Poder 10
 * y tres habilidades: Golpe con escudo (2, +2 al Ataque), Golpe de tormenta (6, +(3d6) al Ataque y
 * +2 al Dano) y Mano de piedra (no soportada). Con Defensa 11, la cara 1 sin bono iguala.
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

/** Cuenta cuantas veces se consulta Player-Inventory: debe ser UNA por jugador y solo al iniciar. */
const inventoryCalls: string[] = []

/** Poder maximo por jugador: una prueba lo baja para forzar el Poder insuficiente (HU-11). */
const maxPowerOf: Record<string, number> = { 'sujeto-a': 10, 'sujeto-b': 10 }

const stormAbility: EquippedHeroAbility = {
  abilityId: STORM_ID,
  reference: 'golpe-de-tormenta',
  name: 'Golpe de tormenta',
  powerCost: { mode: 'FIXED', amount: 6 },
  chargeTurns: 1,
  effects: [
    {
      kind: 'STAT_MODIFIER',
      target: 'SELF',
      statistic: 'ATTACK',
      operation: 'INCREASE',
      magnitude: { mode: 'DICE', count: 3, sides: 6 },
      hasActivationCondition: false,
    },
    {
      kind: 'STAT_MODIFIER',
      target: 'SELF',
      statistic: 'DAMAGE',
      operation: 'INCREASE',
      magnitude: { mode: 'FIXED', amount: 2 },
      hasActivationCondition: false,
    },
  ],
}

const armasHero = (playerId: string): EquippedHero =>
  equippedHeroFixture({
    playerId,
    heroId: `heroe-de-${playerId}`,
    subtype: 'GUERRERO_ARMAS',
    loadoutVersion: 0,
    activeEffects: [],
    maxPower: maxPowerOf[playerId] ?? 10,
    abilities: [shieldStrikeAbility, stormAbility, stoneHandAbility],
    effectiveStats: {
      power: maxPowerOf[playerId] ?? 10,
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
 * Secuencia HU-24 guionizada: los indices se ENCOLAN justo antes de cada accion. Si el servidor
 * sortea de mas, lanza (un sorteo inesperado rompe el test); si sortea de menos, `pending()` no
 * es 0 y el test lo detecta.
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

describe('HU-19 de extremo a extremo (protocolo): habilidades entre dos clientes WebSocket reales, Combat y MongoDB', () => {
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

  /** Batalla 1v1 iniciada, con los dos clientes ya suscritos. El equipo A abre. */
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

  const skill = (
    roomId: string,
    commandId: string,
    abilityId: string,
    target: unknown = { teamLabel: 'B', seat: 0 },
  ): Record<string, unknown> => ({ type: 'useSkill', commandId, roomId, abilityId, target })

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

  /** Golpe con escudo, resuelto como un golpe: dado de Ataque 5 (10 + 2 + 5 = 17), dano, dado de Dano 4. */
  const shieldHit = (): number[] => [face(5), effect(RandomEffectType.Damage), face(4)]
  /** Ataque basico del rival: dado de Ataque 4 (14 > 11), dano, dado de Dano 2. */
  const basicHit = (): number[] => [face(4), effect(RandomEffectType.Damage), face(2)]

  const skillOf = (view: any, label: string, abilityId: string): any =>
    view.combatants
      .find((c: any) => c.teamLabel === label)
      .skills.find((s: any) => s.abilityId === abilityId)

  describe('flujo principal 1v1 (CA-01, CA-05, CA-08, CA-09)', () => {
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

    it('la vista inicial trae Poder 10/10 y las habilidades de cada participante; MongoDB congela maxPower y abilities', () => {
      const started = a.ofType('battleStarted')[0] as any
      const [first, second] = started.battle.combatants

      expect(first).toMatchObject({ teamLabel: 'A', power: { current: 10, max: 10 } })
      expect(second).toMatchObject({ teamLabel: 'B', power: { current: 10, max: 10 } })
      expect(first.skills.map((s: any) => [s.name, s.status, s.cooldownRemaining])).toEqual([
        ['Golpe con escudo', 'READY', 0],
        ['Golpe de tormenta', 'READY', 0],
        ['Mano de piedra', 'UNSUPPORTED', 0],
      ])
      expect(JSON.stringify(started.battle)).not.toMatch(/effects|statistic|operation|magnitude/)
      expect(before.battle.combatants[0].currentPower).toBe(10)
      expect(before.battle.combatants[0].cooldowns).toEqual({})
      expect(before.battle.combatants[0].profile.maxPower).toBe(10)
      expect(before.battle.combatants[0].profile.abilities).toHaveLength(3)
    })

    it('GOLPE CON ESCUDO: habilidad -> resolucion -> Vida, Poder y recarga -> fin de turno; AMBOS clientes reciben LOS MISMOS bytes', async () => {
      const callsBefore = inventoryCalls.length
      const usedBefore = sequence.used

      sequence.push(...shieldHit())
      a.send(skill(roomId, 'cmd-escudo', shieldStrikeAbility.abilityId))

      const [eventA] = await a.waitFor('skillUsed')
      const [eventB] = await b.waitFor('skillUsed')

      expect(a.raw.find((text) => text.includes('skillUsed'))).toBe(
        b.raw.find((text) => text.includes('skillUsed')),
      )
      expect(eventA).toEqual(eventB)
      expect(eventA).toMatchObject({
        type: 'skillUsed',
        seq: 2,
        roomId,
        commandId: 'cmd-escudo',
        completedPosition: 0,
        actor: { teamLabel: 'A', seat: 0 },
        target: { teamLabel: 'B', seat: 0 },
        skill: {
          abilityId: shieldStrikeAbility.abilityId,
          name: 'Golpe con escudo',
          powerCost: { mode: 'FIXED', amount: 2 },
          chargeTurns: 1,
        },
        power: { before: 10, after: 8 },
        cooldown: { remainingTurns: 1 },
        bonus: { attack: 2, damage: 0 },
        resolution: {
          attackValue: 17,
          defenseValue: 11,
          effective: true,
          baseDamage: 4,
          appliedDamage: 4,
        },
        targetHealth: { before: 44, after: 40 },
      })
      expect(eventA.battle.combatants[0]).toMatchObject({
        teamLabel: 'A',
        health: { current: 44, max: 44 },
        power: { current: 8, max: 10 },
      })
      expect(skillOf(eventA.battle, 'A', shieldStrikeAbility.abilityId)).toMatchObject({
        cooldownRemaining: 1,
        status: 'RECHARGING',
      })
      expect(eventA.battle.turnsCompleted).toBe(1)
      expect(eventA.battle.currentTurn).toMatchObject({ teamLabel: 'B', playerId: 'sujeto-b' })
      // Exactamente los 3 sorteos del orden documentado y nada mas.
      expect(sequence.used - usedBefore).toBe(3)
      expect(sequence.pending()).toBe(0)
      // Ninguna llamada a Player-Inventory por accion.
      expect(inventoryCalls).toHaveLength(callsBefore)
    })

    it('MongoDB: Vida, Poder, recarga, evento, commandId y turno cambiaron JUNTOS en UNA version nueva', async () => {
      const after = await document(roomId)

      expect(after.version).toBe((before.version as number) + 1)
      expect(after.battle.turnsCompleted).toBe(1)
      expect(after.battle.combatants[0].currentPower).toBe(8)
      expect(after.battle.combatants[0].cooldowns).toEqual({ [shieldStrikeAbility.abilityId]: 1 })
      expect(after.battle.combatants[1].currentHealth).toBe(40)
      expect(after.battle.combatants[1].currentPower).toBe(10)
      expect(after.events.at(-1)).toMatchObject({ seq: 2, type: 'skillUsed' })
      expect(after.handledCommands).toEqual([{ commandId: 'cmd-escudo', seq: 2 }])
    })
  })

  describe('orden de sorteos con dados del bono (contrato §4.2)', () => {
    it('GOLPE DE TORMENTA: bono 3d6 (2, 3, 4) ANTES del dado de Ataque (5); Ataque = 10 + 9 + 5 = 24; Dano = 3 + 2 = 5', async () => {
      const { roomId, a, b } = await startedBattle()

      sequence.push(face(2), face(3), face(4), face(5), effect(RandomEffectType.Damage), face(3))
      a.send(skill(roomId, 'cmd-tormenta', STORM_ID))

      const [event] = await a.waitFor('skillUsed')
      await b.waitFor('skillUsed')

      expect(event).toMatchObject({
        power: { before: 10, after: 4 },
        bonus: { attack: 9, damage: 2 },
        resolution: { attackValue: 24, effective: true, baseDamage: 5, appliedDamage: 5 },
        targetHealth: { before: 44, after: 39 },
      })
      expect(sequence.pending()).toBe(0)
      a.close()
      b.close()
    })
  })

  describe('recarga y regeneracion a lo largo de los turnos (CA-04, CA-07, HU-11)', () => {
    it('usada en T queda bloqueada en T + 1 (SKILL_ON_COOLDOWN, 0 sorteos, sin tocar la sala) y libre en T + 2; el Poder regenera +2', async () => {
      const { roomId, a, b } = await startedBattle()

      sequence.push(...shieldHit()) // T1: a usa Golpe con escudo (Poder 10 -> 8)
      a.send(skill(roomId, 'a-1', shieldStrikeAbility.abilityId))
      await a.waitFor('skillUsed')

      sequence.push(...basicHit()) // T2: b ataca; al abrirse el turno de a: 8 + 2 = 10
      b.send(attack(roomId, 'b-1', { teamLabel: 'A', seat: 0 }))
      const [reply] = await a.waitFor('basicAttackResolved')

      expect(reply.battle.combatants[0].power).toEqual({ current: 10, max: 10 })
      expect(skillOf(reply.battle, 'A', shieldStrikeAbility.abilityId)).toMatchObject({
        cooldownRemaining: 1,
        status: 'RECHARGING',
      })

      // T3: a intenta la misma habilidad: en recarga.
      const usedBefore = sequence.used
      const versionBefore = (await document(roomId)).version

      a.send(skill(roomId, 'a-2', shieldStrikeAbility.abilityId))
      const [rejection] = await a.waitFor('command.rejected')

      expect(rejection).toEqual({
        type: 'command.rejected',
        command: 'useSkill',
        commandId: 'a-2',
        code: 'SKILL_ON_COOLDOWN',
      })
      expect(b.ofType('command.rejected')).toEqual([])
      expect(sequence.used).toBe(usedBefore)
      expect((await document(roomId)).version).toBe(versionBefore)

      // a usa un ataque basico (cierra su turno propio y su recarga); b ataca.
      sequence.push(...basicHit())
      a.send(attack(roomId, 'a-3'))
      await a.waitFor('basicAttackResolved', 2)
      sequence.push(...basicHit())
      b.send(attack(roomId, 'b-2', { teamLabel: 'A', seat: 0 }))
      await a.waitFor('basicAttackResolved', 3)

      // T5: disponible otra vez.
      sequence.push(...shieldHit())
      a.send(skill(roomId, 'a-4', shieldStrikeAbility.abilityId))
      const events = await a.waitFor('skillUsed', 2)

      expect(events[1]).toMatchObject({ commandId: 'a-4', power: { before: 10, after: 8 } })
      expect(sequence.pending()).toBe(0)
      a.close()
      b.close()
    })

    it('el ataque basico NO cambia el Poder del atacante (HU-11)', async () => {
      const { roomId, a, b } = await startedBattle()

      sequence.push(...basicHit())
      a.send(attack(roomId, 'solo-ataque'))
      const [event] = await a.waitFor('basicAttackResolved')

      expect(event.battle.combatants[0].power).toEqual({ current: 10, max: 10 })
      expect((await document(roomId)).battle.combatants[0].currentPower).toBe(10)
      expect(event).not.toHaveProperty('degradedFrom')
      a.close()
      b.close()
    })
  })

  describe('Poder insuficiente: se degrada a ataque basico (HU-11, CA-01)', () => {
    afterEach(() => {
      maxPowerOf['sujeto-b'] = 10
    })

    it('con 1 de Poder y una habilidad de 2, llega un ataque basico con degradedFrom; Poder y recarga intactos; el turno avanza', async () => {
      maxPowerOf['sujeto-b'] = 1
      const { roomId, a, b } = await startedBattle()

      sequence.push(...basicHit()) // T1: a ataca.
      a.send(attack(roomId, 'a-1'))
      await b.waitFor('basicAttackResolved')

      // T2: b pide Golpe con escudo (2 de Poder) con 1: se degrada. Ataque basico: 10 + 5 = 15 (sin bono).
      sequence.push(face(5), effect(RandomEffectType.Damage), face(4))
      const usedBefore = sequence.used
      b.send(skill(roomId, 'b-1', shieldStrikeAbility.abilityId, { teamLabel: 'A', seat: 0 }))
      // `waitFor` devuelve TODOS los mensajes de ese tipo: el degradado es el segundo (el primero
      // es el ataque de a en su turno).
      const eventB = (await b.waitFor('basicAttackResolved', 2))[1]
      const eventA = (await a.waitFor('basicAttackResolved', 2))[1]

      expect(a.raw.find((text) => text.includes('b-1'))).toBe(
        b.raw.find((text) => text.includes('b-1')),
      )
      expect(eventA).toEqual(eventB)
      expect(eventB).toMatchObject({
        type: 'basicAttackResolved',
        commandId: 'b-1',
        degradedFrom: {
          command: 'useSkill',
          abilityId: shieldStrikeAbility.abilityId,
          reason: 'INSUFFICIENT_POWER',
        },
        resolution: { attackValue: 15, effective: true },
      })
      expect(eventB.battle.combatants[1].power).toEqual({ current: 1, max: 1 })
      expect(skillOf(eventB.battle, 'B', shieldStrikeAbility.abilityId)).toMatchObject({
        cooldownRemaining: 0,
        status: 'READY',
      })
      expect(sequence.used - usedBefore).toBe(3)

      const after = await document(roomId)

      expect(after.battle.combatants[1].currentPower).toBe(1)
      expect(after.battle.combatants[1].cooldowns).toEqual({})
      expect(after.battle.turnsCompleted).toBe(2)
      expect(after.events.at(-1).type).toBe('basicAttackResolved')
      a.close()
      b.close()
    })
  })

  describe('rechazos: 0 sorteos, nada cambia y solo se le responde al remitente', () => {
    it.each([
      [
        'una habilidad que el heroe no tiene (CA-02)',
        { abilityId: '99999999-9999-4999-8999-999999999999' },
        'UNKNOWN_SKILL',
      ],
      [
        'un efecto no soportado (Mano de piedra: duracion y condicion)',
        { abilityId: stoneHandAbility.abilityId },
        'UNSUPPORTED_SKILL_EFFECT',
      ],
      ['un objetivo inexistente', { target: { teamLabel: 'Z', seat: 0 } }, 'INVALID_TARGET'],
      [
        'un objetivo del propio equipo',
        { target: { teamLabel: 'A', seat: 0 } },
        'SAME_TEAM_TARGET',
      ],
      ['una clave de mas (el cliente no aporta el costo)', { powerCost: 0 }, 'MALFORMED_COMMAND'],
      ['un abilityId que no es un UUID', { abilityId: 'golpe-con-escudo' }, 'MALFORMED_COMMAND'],
    ])('%s', async (_label, patch, code) => {
      const { roomId, a, b } = await startedBattle()
      const before = await document(roomId)
      const usedBefore = sequence.used

      a.send({ ...skill(roomId, 'cmd-rechazo', shieldStrikeAbility.abilityId), ...patch })
      const [rejection] = await a.waitFor('command.rejected')

      expect(rejection).toMatchObject({ command: 'useSkill', commandId: 'cmd-rechazo', code })
      await settle()
      expect(b.ofType('command.rejected')).toEqual([])
      expect(b.ofType('skillUsed')).toEqual([])
      expect(sequence.used).toBe(usedBefore)
      expect((await document(roomId)).version).toBe(before.version)
      expect((await document(roomId)).battle.combatants[0].currentPower).toBe(10)
      a.close()
      b.close()
    })

    it('fuera de turno: NOT_YOUR_TURN sin cobrar Poder', async () => {
      const { roomId, a, b } = await startedBattle()

      b.send(skill(roomId, 'b-fuera', shieldStrikeAbility.abilityId, { teamLabel: 'A', seat: 0 }))
      const [rejection] = await b.waitFor('command.rejected')

      expect(rejection).toMatchObject({ code: 'NOT_YOUR_TURN', command: 'useSkill' })
      expect((await document(roomId)).battle.combatants[1].currentPower).toBe(10)
      a.close()
      b.close()
    })

    it('sin motivo interno: un efecto no soportado NO expone por que', async () => {
      const { roomId, a, b } = await startedBattle()

      a.send(skill(roomId, 'cmd-motivo', stoneHandAbility.abilityId))
      await a.waitFor('command.rejected')

      expect(a.raw.join('')).not.toMatch(/duracion|condicion|DEFENSE|estado de batalla/)
      a.close()
      b.close()
    })
  })

  describe('idempotencia y concurrencia reales', () => {
    it('el MISMO commandId repetido devuelve el mismo evento SOLO al remitente: sin sorteo, sin segundo cobro de Poder, sin segunda recarga', async () => {
      const { roomId, a, b } = await startedBattle()

      sequence.push(...shieldHit())
      a.send(skill(roomId, 'cmd-repetido', shieldStrikeAbility.abilityId))
      await a.waitFor('skillUsed')
      await b.waitFor('skillUsed')
      const original = a.raw.find((text) => text.includes('skillUsed'))
      const usedBefore = sequence.used
      const versionBefore = (await document(roomId)).version

      a.send(skill(roomId, 'cmd-repetido', shieldStrikeAbility.abilityId))
      await a.waitFor('skillUsed', 2)
      await settle()

      expect(a.raw.filter((text) => text.includes('skillUsed'))).toEqual([original, original])
      expect(b.ofType('skillUsed')).toHaveLength(1)
      expect(sequence.used).toBe(usedBefore)
      expect((await document(roomId)).version).toBe(versionBefore)
      expect((await document(roomId)).battle.combatants[0].currentPower).toBe(8)
      a.close()
      b.close()
    })

    it('DOS comandos DISTINTOS a la vez de dos pestanas del mismo jugador: solo UNO muta; el otro NOT_YOUR_TURN; un solo cobro y una sola recarga', async () => {
      const { roomId, a, b } = await startedBattle()
      const pestana = await connect('token-a')

      pestana.send({ type: 'resume', roomId })
      await pestana.waitFor('resume.ok')

      sequence.push(...shieldHit())
      const usedBefore = sequence.used

      a.send(skill(roomId, 'cmd-x', shieldStrikeAbility.abilityId))
      pestana.send(skill(roomId, 'cmd-y', shieldStrikeAbility.abilityId))
      await settle(600)

      const executed = [...a.ofType('skillUsed'), ...pestana.ofType('skillUsed')]
      const rejected = [...a.ofType('command.rejected'), ...pestana.ofType('command.rejected')]

      // Cada pestana recibe el evento difundido (ambas hicieron resume): UN evento, dos copias.
      expect(new Set(executed.map((event) => event.commandId)).size).toBe(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]).toMatchObject({ code: 'NOT_YOUR_TURN', command: 'useSkill' })
      expect(sequence.used - usedBefore).toBe(3)

      const after = await document(roomId)

      expect(after.battle.turnsCompleted).toBe(1)
      expect(after.battle.combatants[0].currentPower).toBe(8)
      expect(after.battle.combatants[0].cooldowns).toEqual({ [shieldStrikeAbility.abilityId]: 1 })
      a.close()
      b.close()
      pestana.close()
    })
  })

  describe('desconexion, recarga y reinicio: el resultado persistido se recupera EXACTO', () => {
    it('RECONEXION: si B se cae y A usa una habilidad, al volver B la recibe por resume con el Poder, la recarga y el turno correctos', async () => {
      const { roomId, a, b } = await startedBattle()

      b.close()
      await b.waitClose()

      sequence.push(...shieldHit())
      a.send(skill(roomId, 'cmd-mientras-cae', shieldStrikeAbility.abilityId))
      await a.waitFor('skillUsed')

      const back = await connect('token-b')

      back.send({ type: 'resume', roomId, lastSeq: 1 })
      await back.waitFor('resume.ok')

      const [replayed] = back.ofType('skillUsed')

      expect(back.ofType('snapshot')).toEqual([])
      expect(replayed).toEqual(a.ofType('skillUsed')[0])
      expect(back.raw.find((text) => text.includes('skillUsed'))).toBe(
        a.raw.find((text) => text.includes('skillUsed')),
      )
      expect(replayed.power).toEqual({ before: 10, after: 8 })
      expect(replayed.battle.currentTurn).toMatchObject({ playerId: 'sujeto-b' })
      a.close()
      back.close()
    })

    it('RECARGA (resume sin lastSeq): el snapshot trae el Poder, la recarga, la Vida y el turno vigentes', async () => {
      const { roomId, a, b } = await startedBattle()

      sequence.push(...shieldHit())
      a.send(skill(roomId, 'cmd-recarga', shieldStrikeAbility.abilityId))
      await b.waitFor('skillUsed')

      const refreshed = await connect('token-b')

      refreshed.send({ type: 'resume', roomId })
      await refreshed.waitFor('resume.ok')

      const [snapshot] = refreshed.ofType('snapshot')
      const room = await call('GET', `/rooms/${roomId}`, 'token-b')

      expect(snapshot).toMatchObject({ roomId, seq: 2, status: 'IN_BATTLE' })
      expect(snapshot.battle.combatants[0]).toMatchObject({
        teamLabel: 'A',
        power: { current: 8, max: 10 },
        health: { current: 44, max: 44 },
      })
      expect(skillOf(snapshot.battle, 'A', shieldStrikeAbility.abilityId)).toMatchObject({
        cooldownRemaining: 1,
        status: 'RECHARGING',
      })
      expect(snapshot.battle).toEqual(room.body.battle)
      a.close()
      b.close()
      refreshed.close()
    })

    it('REINICIO de Combat: el Poder y la recarga sobreviven y el combate continua desde ese estado', async () => {
      const { roomId, a, b } = await startedBattle()

      sequence.push(...shieldHit())
      a.send(skill(roomId, 'cmd-antes-del-reinicio', shieldStrikeAbility.abilityId))
      await a.waitFor('skillUsed')
      a.close()
      b.close()

      await app.close()
      await boot()

      const b2 = await connect('token-b')

      b2.send({ type: 'resume', roomId, lastSeq: 1 })
      await b2.waitFor('resume.ok')
      expect(b2.ofType('skillUsed')[0].power).toEqual({ before: 10, after: 8 })

      // El rival responde y al abrirse el turno de A regenera desde el Poder guardado en MongoDB.
      sequence.push(...basicHit())
      b2.send(attack(roomId, 'cmd-despues-del-reinicio', { teamLabel: 'A', seat: 0 }))
      const events = await b2.waitFor('basicAttackResolved')

      expect(events[0].battle.combatants[0].power).toEqual({ current: 10, max: 10 })
      expect(skillOf(events[0].battle, 'A', shieldStrikeAbility.abilityId).cooldownRemaining).toBe(
        1,
      )
      b2.close()
    }, 60_000)
  })

  describe('batallas anteriores a HU-19 y migracion 008', () => {
    it('una batalla de HU-18 (sin Poder ni habilidades) se restaura, useSkill responde SKILLS_NOT_AVAILABLE y el ataque basico sigue', async () => {
      const { roomId, a, b } = await startedBattle()

      // Deja el documento exactamente como lo escribia HU-18 (migracion 007): sin nada de HU-19.
      await db.collection('battle-rooms').updateOne(
        { _id: roomId as never },
        {
          $unset: {
            'battle.combatants.0.currentPower': '',
            'battle.combatants.0.cooldowns': '',
            'battle.combatants.0.profile.maxPower': '',
            'battle.combatants.0.profile.abilities': '',
            'battle.combatants.1.currentPower': '',
            'battle.combatants.1.cooldowns': '',
            'battle.combatants.1.profile.maxPower': '',
            'battle.combatants.1.profile.abilities': '',
          },
        },
      )
      a.close()
      b.close()

      const a2 = await connect('token-a')

      a2.send({ type: 'resume', roomId })
      await a2.waitFor('resume.ok')
      expect(a2.ofType('snapshot')[0].battle.combatants[0]).toEqual({
        teamLabel: 'A',
        seat: 0,
        health: { current: 44, max: 44 },
        power: null,
        skills: [],
      })

      const usedBefore = sequence.used

      a2.send(skill(roomId, 'legacy', shieldStrikeAbility.abilityId))
      const [rejection] = await a2.waitFor('command.rejected')

      expect(rejection).toMatchObject({ code: 'SKILLS_NOT_AVAILABLE', command: 'useSkill' })
      expect(sequence.used).toBe(usedBefore)

      // El ataque basico sigue igual y NO inventa Poder ni habilidades.
      sequence.push(...basicHit())
      a2.send(attack(roomId, 'legacy-attack'))
      await a2.waitFor('basicAttackResolved')

      const after = await document(roomId)

      expect(after.battle.combatants[0]).not.toHaveProperty('currentPower')
      expect(after.battle.combatants[0].profile).not.toHaveProperty('maxPower')
      expect(after.battle.turnsCompleted).toBe(1)
      a2.close()
    })

    it('el validador de la migracion 008 acepta los campos y el evento nuevos y rechaza un Poder o una recarga invalidos', async () => {
      const { roomId, a, b } = await startedBattle()
      const collection = db.collection<Record<string, any>>('battle-rooms')

      await expect(
        collection.updateOne(
          { _id: roomId as never },
          { $set: { 'battle.combatants.0.currentPower': -1 } },
        ),
      ).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        collection.updateOne(
          { _id: roomId as never },
          { $set: { 'battle.combatants.0.currentPower': 'diez' } },
        ),
      ).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        collection.updateOne(
          { _id: roomId as never },
          { $set: { 'battle.combatants.0.cooldowns': 'no' } },
        ),
      ).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        collection.updateOne(
          { _id: roomId as never },
          { $set: { 'battle.combatants.0.profile.maxPower': -3 } },
        ),
      ).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        collection.updateOne(
          { _id: roomId as never },
          { $set: { 'battle.combatants.0.profile.abilities.0.powerCost.mode': 'NONE' } },
        ),
      ).rejects.toBeInstanceOf(MongoServerError)
      await expect(
        collection.updateOne(
          { _id: roomId as never },
          { $set: { 'battle.combatants.0.profile.abilities.0.inventario': {} } },
        ),
      ).rejects.toBeInstanceOf(MongoServerError)

      // El flujo real escribe el evento `skillUsed` sin objecion del validador.
      sequence.push(...shieldHit())
      a.send(skill(roomId, 'cmd-validador', shieldStrikeAbility.abilityId))
      await a.waitFor('skillUsed')
      expect((await document(roomId)).events.at(-1).type).toBe('skillUsed')
      a.close()
      b.close()
    })

    it('down de la migracion 008 vuelve al validador de 007 (rechaza skillUsed) y up lo restablece', async () => {
      const { roomId, a, b } = await startedBattle()
      const collection = db.collection<Record<string, any>>('battle-rooms')
      const skillEvent = {
        seq: 2,
        type: 'skillUsed',
        occurredAt: new Date(),
        payload: {},
      }
      // HU-21: el documento actual se escribe con `battle.turnStartedAt` (y con
      // los campos de HU-19), que los validadores de 007/008 no conocen; el
      // rechazo del motor sigue siendo la garantia de que ninguna escritura no
      // autorizada prospera. Con 008 y luego 009 restablecidos, el evento vuelve
      // a escribirse.
      await downSkillsMigration(db)
      try {
        await expect(
          collection.updateOne({ _id: roomId as never }, {
            $push: { events: skillEvent },
          } as never),
        ).rejects.toBeInstanceOf(MongoServerError)
        await expect(
          collection.updateOne(
            { _id: roomId as never },
            { $set: { 'battle.combatants.0.currentPower': 5 } },
          ),
        ).rejects.toBeInstanceOf(MongoServerError)
      } finally {
        await upSkillsMigration(db)
        await upFinishMigration(db)
      }

      await expect(
        collection.updateOne({ _id: roomId as never }, { $push: { events: skillEvent } } as never),
      ).resolves.toMatchObject({ modifiedCount: 1 })
      a.close()
      b.close()
    })
  })

  it('al terminar no quedan sorteos sin consumir: ningun test dejo la secuencia guionizada con indices de mas', () => {
    expect(sequence.pending()).toBe(0)
  })
})
