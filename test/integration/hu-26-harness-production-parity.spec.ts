import 'reflect-metadata'

import { Test } from '@nestjs/testing'

import {
  RANDOM_SEQUENCE_FACTORY,
  type RandomSequenceFactoryPort,
} from '../../src/application/ports/RandomSequencePort'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { generateIndexSample } from '../../tools/hu-26/index-sample-generation'
import { createProductionRandomSequenceFactory } from '../../tools/hu-26/production-factory'
import { generateNormalSample } from '../../tools/hu-26/sample-generation'

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
 * Paridad harness <-> runtime (HU-26): el estudio valida EL CODIGO QUE CORRE EN
 * PRODUCCION. La fabrica que usa el harness y la que Nest resuelve desde el
 * contenedor deben producir exactamente las mismas secuencias, normales e indices.
 */
describe('HU-26: el harness genera exactamente lo que genera el runtime de Combat', () => {
  let runtimeFactory: RandomSequenceFactoryPort
  let restore: () => void
  let close: () => Promise<void>

  beforeAll(async () => {
    restore = withEnv({ AUTH_MODE: 'disabled', PERSISTENCE_DRIVER: 'memory', NODE_ENV: 'test' })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleRef.createNestApplication()
    await app.init()
    runtimeFactory = app.get<RandomSequenceFactoryPort>(RANDOM_SEQUENCE_FACTORY)
    close = () => app.close()
  })

  afterAll(async () => {
    await close()
    restore()
  })

  it.each([0, 42, 3_000_000, RandomSeed.MAX])(
    'semilla %i: mismas normales e indices que la fabrica del contenedor',
    (raw) => {
      const seed = RandomSeed.create(raw)
      const harness = createProductionRandomSequenceFactory()

      expect(Array.from(generateNormalSample(harness, seed, 500))).toEqual(
        Array.from(generateNormalSample(runtimeFactory, seed, 500)),
      )
      expect(Array.from(generateIndexSample(harness, seed, 500))).toEqual(
        Array.from(generateIndexSample(runtimeFactory, seed, 500)),
      )
    },
  )
})
