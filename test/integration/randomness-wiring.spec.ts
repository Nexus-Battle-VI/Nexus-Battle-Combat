import 'reflect-metadata'

import { type INestApplication, ValidationPipe } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import {
  RANDOM_SEQUENCE_FACTORY,
  type RandomSequenceFactoryPort,
} from '../../src/application/ports/RandomSequencePort'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

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

/**
 * HU-24: el motor esta REGISTRADO en la raiz de composicion pero NO expuesto.
 * ADR-019: ninguna ruta publica genera numeros ni acepta semilla/indice; la
 * aleatoriedad es autoridad exclusiva del servidor.
 */
describe('Cableado del motor pseudoaleatorio (HU-24)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({ AUTH_MODE: 'disabled', PERSISTENCE_DRIVER: 'memory', NODE_ENV: 'test' })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  it('RANDOM_SEQUENCE_FACTORY se resuelve desde el contenedor y crea secuencias validas', () => {
    const factory = app.get<RandomSequenceFactoryPort>(RANDOM_SEQUENCE_FACTORY)
    const sequence = factory.create(RandomSeed.create(3_000_000))

    expect(sequence.nextIndex().value).toBe(2648)
    expect(sequence.nextIndex().value).toBe(3529)
  })

  it('cada resolucion comparte la MISMA fabrica pero las secuencias no comparten cursor', () => {
    const factory = app.get<RandomSequenceFactoryPort>(RANDOM_SEQUENCE_FACTORY)
    const seed = RandomSeed.create(3_000_000)
    const first = factory.create(seed)
    first.nextIndex()

    expect(factory.create(seed).nextIndex().value).toBe(2648)
  })

  it.each([
    ['GET', '/api/random'],
    ['POST', '/api/random'],
    ['POST', '/api/seed'],
    ['GET', '/api/v1/combat/random'],
    ['POST', '/api/v1/combat/random'],
    ['POST', '/api/v1/combat/seed'],
    ['POST', '/api/v1/combat/randomness'],
  ] as const)('no existe ningun endpoint publico de aleatoriedad: %s %s', async (method, path) => {
    const server = app.getHttpServer()
    const response =
      method === 'GET'
        ? await request(server).get(path)
        : await request(server).post(path).send({ seed: 1, index: 1 })

    expect(response.status).toBe(404)
  })
})
