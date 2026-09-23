import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { BATTLE_RANDOM } from '../../src/adapters/inbound/http/tokens'
import { InMemoryExperienceRollRepository } from '../../src/adapters/outbound/persistence/InMemoryExperienceRollRepository'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { EXPERIENCE_ROLL_REPOSITORY } from '../../src/application/ports/ExperienceRollRepositoryPort'
import type {
  ExperienceRollBatchIntent,
  ExperienceRollBatchSnapshot,
  ExperienceRollInsertResult,
  ExperienceRollRepositoryPort,
} from '../../src/application/ports/ExperienceRollRepositoryPort'
import type { BoundedRandom } from '../../src/domain/policies/TurnOrderPolicy'
import { AppModule, INTERNAL_CALLERS } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Contrato HTTP interno de la tirada de experiencia (HU-09,
 * `hu-09-experience-reward-v1` §5.2, Task HU-09.2) sobre
 * `PERSISTENCE_DRIVER=memory`.
 *
 * Es la unica ruta interna de Combat y la consume Missions con firma HMAC. Aqui
 * se comprueba el contrato entero: la firma, los codigos de error prometidos, la
 * idempotencia por `operationId` y que el lote quede persistido antes de
 * responder.
 */
const SECRET = 'secreto-de-pruebas'
const PATH = '/api/internal/v1/combat/experience-rolls'
const OPERATION_ID = 'mission:enr_01JB8Y3K7Q:xp-rolls'

const BODY = {
  schemaVersion: 1,
  operationId: OPERATION_ID,
  enrollmentId: 'enr_01JB8Y3K7Q',
  simulationId: 'sim_01JB8Y4B',
  heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
  defeats: [
    { encounterId: '1', enemyInstanceId: 'sombra-corrompida#1', rivalRef: 'sombra-corrompida' },
    { encounterId: '1', enemyInstanceId: 'sombra-corrompida#2', rivalRef: 'sombra-corrompida' },
    { encounterId: '5', enemyInstanceId: 'guardian-eterno#1', rivalRef: 'guardian-eterno' },
  ],
}

/**
 * Fuente de azar determinista y CICLICA: `[0, 4, 7]` -> caras `1, 5, 8` en cada
 * lote nuevo. Cicla para que varias peticiones del mismo fichero reciban la
 * misma secuencia sin agotarla; lo que se afirma sobre el consumo de azar se
 * hace comparando `bounds.length` antes y despues, no el valor.
 */
class ScriptedRandom implements BoundedRandom {
  readonly bounds: number[] = []
  private cursor = 0

  constructor(private readonly values: readonly number[]) {}

  nextInt(bound: number): number {
    this.bounds.push(bound)

    const value = this.values[this.cursor % this.values.length]
    this.cursor += 1

    if (value === undefined) {
      throw new Error('La secuencia de prueba no tiene valores.')
    }

    return value
  }
}

/**
 * Repositorio que delega en el real y falla a proposito para los lotes cuyo
 * `operationId` contiene `:fallo`, para poder ejercitar el `503 ROLL_UNAVAILABLE`
 * del contrato -- un fallo de la persistencia que Missions debe reintentar con
 * el MISMO `operationId`, no un 500.
 */
class FlakyRepository implements ExperienceRollRepositoryPort {
  constructor(private readonly inner: InMemoryExperienceRollRepository) {}

  findById(operationId: string): Promise<ExperienceRollBatchSnapshot | null> {
    if (operationId.includes(':fallo')) {
      return Promise.reject(new Error('la Base no responde'))
    }

    return this.inner.findById(operationId)
  }

  insertIfAbsent(intent: ExperienceRollBatchIntent): Promise<ExperienceRollInsertResult> {
    if (intent.operationId.includes(':fallo')) {
      return Promise.reject(new Error('la Base no responde'))
    }

    return this.inner.insertIfAbsent(intent)
  }
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

describe('POST /api/internal/v1/combat/experience-rolls', () => {
  let app: INestApplication
  let restore: () => void
  let repository: InMemoryExperienceRollRepository
  let random: ScriptedRandom

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'disabled',
      PERSISTENCE_DRIVER: 'memory',
      INTERNAL_SERVICE_AUTH_SECRET: SECRET,
    })

    repository = new InMemoryExperienceRollRepository()
    random = new ScriptedRandom([0, 4, 7])
    const port = new FlakyRepository(repository)

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EXPERIENCE_ROLL_REPOSITORY)
      .useValue(port)
      .overrideProvider(BATTLE_RANDOM)
      .useValue(random)
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

  /** Firma la peticion como lo haria Missions: servicio, metodo, ruta, sello y cuerpo. */
  const signed = (body: unknown, service = 'missions') => {
    const timestamp = String(Date.now())

    return request(app.getHttpServer())
      .post(PATH)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set(
        'x-internal-signature',
        signInternalRequest(SECRET, { service, method: 'POST', path: PATH, timestamp, body }),
      )
      .send(body as object)
  }

  it('la lista cerrada de consumidores sigue siendo SOLO missions (no se amplia)', () => {
    expect(INTERNAL_CALLERS).toEqual(['missions'])
  })

  it('sin firma responde 401 y no toca la persistencia', async () => {
    const response = await request(app.getHttpServer()).post(PATH).send(BODY)

    expect(response.status).toBe(401)
    expect(await repository.findById(OPERATION_ID)).toBeNull()
  })

  it('un servicio que no es consumidor responde 401', async () => {
    expect((await signed(BODY, 'catalog')).status).toBe(401)
  })

  it('firmado por missions: 200 con una tirada por derrota, en el orden de la peticion', async () => {
    const response = await signed(BODY)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      applied: true,
      rolls: [
        {
          encounterId: '1',
          enemyInstanceId: 'sombra-corrompida#1',
          roll: 1,
          persistedAt: expect.any(String),
        },
        {
          encounterId: '1',
          enemyInstanceId: 'sombra-corrompida#2',
          roll: 5,
          persistedAt: expect.any(String),
        },
        {
          encounterId: '5',
          enemyInstanceId: 'guardian-eterno#1',
          roll: 8,
          persistedAt: expect.any(String),
        },
      ],
    })
  })

  it('`persistedAt` es ISO-8601 con milisegundos, como el ejemplo del contrato', async () => {
    const response = await signed({ ...BODY, operationId: `${OPERATION_ID}:iso` })

    expect(response.body.rolls[0].persistedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it('`rivalRef` NO viaja en la respuesta: el contrato declara cuatro campos por tirada', async () => {
    const response = await signed({ ...BODY, operationId: `${OPERATION_ID}:campos` })

    expect(Object.keys(response.body.rolls[0]).sort()).toEqual([
      'encounterId',
      'enemyInstanceId',
      'persistedAt',
      'roll',
    ])
  })

  it('el lote queda PERSISTIDO antes de responder, con las mismas tiradas', async () => {
    const stored = await repository.findById(OPERATION_ID)

    expect(stored?.defeats.map((defeat) => defeat.roll)).toEqual([1, 5, 8])
    expect(stored?.defeats.map((defeat) => defeat.enemyInstanceId)).toEqual([
      'sombra-corrompida#1',
      'sombra-corrompida#2',
      'guardian-eterno#1',
    ])
  })

  it('el reintento con el MISMO cuerpo devuelve lo guardado con applied:false y no tira otra vez', async () => {
    const consumed = random.bounds.length

    const response = await signed(BODY)

    expect(response.status).toBe(200)
    expect(response.body.applied).toBe(false)
    expect(response.body.rolls.map((roll: { roll: number }) => roll.roll)).toEqual([1, 5, 8])
    expect(random.bounds).toHaveLength(consumed)
  })

  it('el mismo operationId con OTRA lista de derrotas responde 409 OPERATION_ID_REUSED', async () => {
    const response = await signed({
      ...BODY,
      defeats: [BODY.defeats[2], BODY.defeats[0]],
    })

    expect(response.status).toBe(409)
    expect(response.body.code).toBe('OPERATION_ID_REUSED')
    // El lote guardado no se toco.
    expect((await repository.findById(OPERATION_ID))?.defeats).toHaveLength(3)
  })

  it('un lote VACIO responde 400 SCHEMA_INVALID y no persiste nada', async () => {
    const response = await signed({
      ...BODY,
      operationId: 'mission:enr-vacio:xp-rolls',
      defeats: [],
    })

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('SCHEMA_INVALID')
    expect(await repository.findById('mission:enr-vacio:xp-rolls')).toBeNull()
  })

  it('la misma instancia dos veces responde 422 DUPLICATE_DEFEAT', async () => {
    const response = await signed({
      ...BODY,
      operationId: 'mission:enr-duplicado:xp-rolls',
      defeats: [BODY.defeats[0], BODY.defeats[0]],
    })

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('DUPLICATE_DEFEAT')
  })

  it('una schemaVersion distinta responde 400 SCHEMA_INVALID', async () => {
    const response = await signed({
      ...BODY,
      operationId: 'mission:enr-version:xp-rolls',
      schemaVersion: 2,
    })

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('SCHEMA_INVALID')
  })

  it('un campo que el contrato no declara responde 400 (no se cuela al caso de uso)', async () => {
    const response = await signed({
      ...BODY,
      operationId: 'mission:enr-extra:xp-rolls',
      xpAmount: 999,
    })

    expect(response.status).toBe(400)
    expect(await repository.findById('mission:enr-extra:xp-rolls')).toBeNull()
  })

  it('el rango aleatorio se pide SIEMPRE como 1d8: cota 8, nunca otra', async () => {
    await signed({
      ...BODY,
      operationId: 'mission:enr-cota:xp-rolls',
      defeats: [BODY.defeats[0]],
    })

    expect(random.bounds.slice(-1)).toEqual([8])
  })

  it('un fallo de la persistencia responde 503 ROLL_UNAVAILABLE, no 500 ni tiradas inventadas', async () => {
    const response = await signed({ ...BODY, operationId: 'mission:enr:fallo:xp-rolls' })

    expect(response.status).toBe(503)
    expect(response.body.code).toBe('ROLL_UNAVAILABLE')
  })
})
