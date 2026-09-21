import 'reflect-metadata'

import { type INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

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
 * HU-20: la resolucion de un golpe NO esta expuesta. Un cliente que pudiera
 * aportar el Ataque o la Defensa podria manipular el resultado (HU-24, CA-05: los
 * clientes no generan los valores que determinan los resultados del juego). Solo
 * el flujo de batalla del servidor (HU-17/HU-18) podra invocarla.
 */
describe('Cableado de la resolucion de golpes (HU-20)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({ AUTH_MODE: 'disabled', PERSISTENCE_DRIVER: 'memory', NODE_ENV: 'test' })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  it.each([
    ['POST', '/api/v1/combat/attacks'],
    ['POST', '/api/v1/combat/attack'],
    ['POST', '/api/v1/combat/attacks/resolve'],
    ['POST', '/api/v1/combat/resolve-attack'],
    ['POST', '/api/v1/combat/rooms/sala-1/attacks'],
    ['POST', '/api/internal/v1/combat/attacks'],
    ['GET', '/api/v1/combat/attacks'],
  ] as const)('no existe ningun endpoint de ataque: %s %s', async (method, path) => {
    const server = app.getHttpServer()
    const response =
      method === 'GET'
        ? await request(server).get(path)
        : await request(server).post(path).send({ attack: 99, defense: 0, index: 1 })

    expect(response.status).toBe(404)
  })
})
