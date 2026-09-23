import type { BoundedRandom } from '../../src/domain/policies/TurnOrderPolicy'
import {
  DuplicateDefeatError,
  ExperienceRollOperationReusedError,
  InvalidExperienceRollRequestError,
} from '../../src/application/errors/ExperienceRollErrors'
import { InMemoryExperienceRollRepository } from '../../src/adapters/outbound/persistence/InMemoryExperienceRollRepository'
import type {
  ExperienceRollBatchIntent,
  ExperienceRollBatchSnapshot,
  ExperienceRollInsertResult,
  ExperienceRollRepositoryPort,
} from '../../src/application/ports/ExperienceRollRepositoryPort'
import {
  EXPERIENCE_ROLLS_SCHEMA_VERSION,
  ResolveExperienceRolls,
  type ResolveExperienceRollsCommand,
} from '../../src/application/use-cases/ResolveExperienceRolls'

/**
 * Caso de uso de la tirada de experiencia (HU-09, `hu-09-experience-reward-v1`
 * §5.2, Task HU-09.2).
 *
 * Lo que se comprueba, y por que importa cada cosa:
 *   - UNA tirada por derrota y ninguna de mas;
 *   - el lote se PERSISTE antes de responder;
 *   - un reintento con el mismo `operationId` NO TIRA OTRA VEZ (la garantia que
 *     impide pagar dos veces el mismo hecho) y devuelve lo guardado con
 *     `applied: false`;
 *   - el mismo `operationId` con OTRA lista es 409 y no sobrescribe nada;
 *   - un lote invalido no consume azar ni toca la persistencia.
 */

/** Fuente de azar de prueba: valores dados, cotas pedidas anotadas. */
class ScriptedRandom implements BoundedRandom {
  readonly bounds: number[] = []
  private cursor = 0

  constructor(private readonly values: readonly number[]) {}

  nextInt(bound: number): number {
    this.bounds.push(bound)

    const value = this.values[this.cursor]
    this.cursor += 1

    if (value === undefined) {
      throw new Error('La secuencia de prueba se agoto: se pidio una tirada de mas.')
    }

    return value
  }
}

/** Repositorio de prueba que ademas deja ver cuantas veces se le llamo. */
class RecordingRepository implements ExperienceRollRepositoryPort {
  readonly reads: string[] = []
  readonly writes: ExperienceRollBatchIntent[] = []
  readonly stored = new Map<string, ExperienceRollBatchSnapshot>()
  /** Cuando es `true`, `insertIfAbsent` simula perder la carrera. */
  loseRace = false

  findById(operationId: string): Promise<ExperienceRollBatchSnapshot | null> {
    this.reads.push(operationId)

    return Promise.resolve(this.stored.get(operationId) ?? null)
  }

  insertIfAbsent(intent: ExperienceRollBatchIntent): Promise<ExperienceRollInsertResult> {
    this.writes.push(intent)

    const existing = this.stored.get(intent.operationId)

    if (existing !== undefined) {
      return Promise.resolve({ batch: existing, created: false })
    }

    const now = new Date('2026-10-02T03:00:04.120Z')
    const batch: ExperienceRollBatchSnapshot = {
      operationId: intent.operationId,
      enrollmentId: intent.enrollmentId,
      simulationId: intent.simulationId,
      heroId: intent.heroId,
      defeats: intent.defeats.map((defeat) => ({ ...defeat, persistedAt: now })),
      createdAt: now,
    }

    if (this.loseRace) {
      // Otro proceso gano: el lote queda guardado por el, no por esta llamada.
      this.stored.set(intent.operationId, {
        ...batch,
        defeats: batch.defeats.map((defeat) => ({ ...defeat, roll: 8 })),
      })

      return Promise.resolve({ batch: this.stored.get(intent.operationId)!, created: false })
    }

    this.stored.set(intent.operationId, batch)

    return Promise.resolve({ batch, created: true })
  }
}

const DEFEATS = [
  { encounterId: '1', enemyInstanceId: 'sombra-corrompida#1', rivalRef: 'sombra-corrompida' },
  { encounterId: '1', enemyInstanceId: 'sombra-corrompida#2', rivalRef: 'sombra-corrompida' },
  { encounterId: '5', enemyInstanceId: 'guardian-eterno#1', rivalRef: 'guardian-eterno' },
]

const commandWith = (
  overrides: Partial<ResolveExperienceRollsCommand> = {},
): ResolveExperienceRollsCommand => ({
  schemaVersion: EXPERIENCE_ROLLS_SCHEMA_VERSION,
  operationId: 'mission:enr_01JB8Y3K7Q:xp-rolls',
  enrollmentId: 'enr_01JB8Y3K7Q',
  simulationId: 'sim_01JB8Y4B',
  heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
  defeats: DEFEATS,
  ...overrides,
})

describe('ResolveExperienceRolls', () => {
  let repository: RecordingRepository
  let random: ScriptedRandom
  let useCase: ResolveExperienceRolls

  beforeEach(() => {
    repository = new RecordingRepository()
    random = new ScriptedRandom([0, 4, 7])
    useCase = new ResolveExperienceRolls(repository, random)
  })

  it('tira una vez por derrota, en orden, y persiste el lote antes de responder', async () => {
    const result = await useCase.execute(commandWith())

    expect(result.applied).toBe(true)
    expect(result.operationId).toBe('mission:enr_01JB8Y3K7Q:xp-rolls')
    expect(result.defeats.map((defeat) => defeat.roll)).toEqual([1, 5, 8])
    expect(repository.writes).toHaveLength(1)
    expect(repository.writes[0]?.defeats.map((defeat) => defeat.roll)).toEqual([1, 5, 8])
  })

  it('pide SIEMPRE la cota 8 -- el 1d8 del contrato -- y una vez por derrota', async () => {
    await useCase.execute(commandWith())

    expect(random.bounds).toEqual([8, 8, 8])
  })

  it('un lote de UNA derrota es el mismo contrato, no una operacion aparte', async () => {
    const result = await useCase.execute(commandWith({ defeats: [DEFEATS[0]!] }))

    expect(result.defeats).toHaveLength(1)
    expect(random.bounds).toHaveLength(1)
  })

  it('devuelve cada tirada con su fecha de persistencia', async () => {
    const result = await useCase.execute(commandWith())

    expect(result.defeats.every((defeat) => defeat.persistedAt instanceof Date)).toBe(true)
  })

  it('NUNCA tira dos veces por el mismo lote: un reintento devuelve lo guardado con applied:false', async () => {
    const first = await useCase.execute(commandWith())
    const consumedAfterFirst = random.bounds.length

    const replay = await useCase.execute(commandWith())

    expect(replay.applied).toBe(false)
    expect(replay.defeats.map((defeat) => defeat.roll)).toEqual(
      first.defeats.map((defeat) => defeat.roll),
    )
    // Ni una tirada mas: el cursor de azar del proceso no se vuelve a tocar.
    expect(random.bounds).toHaveLength(consumedAfterFirst)
    expect(repository.writes).toHaveLength(1)
  })

  it('si otro proceso gano la carrera, responde lo GUARDADO y no lo que se tiro', async () => {
    repository.loseRace = true

    const result = await useCase.execute(commandWith())

    expect(result.applied).toBe(false)
    expect(result.defeats.map((defeat) => defeat.roll)).toEqual([8, 8, 8])
  })

  it('el mismo operationId con OTRA lista de derrotas es 409 y no sobrescribe el lote', async () => {
    await useCase.execute(commandWith())

    await expect(
      useCase.execute(commandWith({ defeats: [DEFEATS[2]!, DEFEATS[0]!] })),
    ).rejects.toThrow(ExperienceRollOperationReusedError)

    expect(repository.writes).toHaveLength(1)
    expect(repository.stored.get('mission:enr_01JB8Y3K7Q:xp-rolls')?.defeats).toHaveLength(3)
  })

  it('el mismo operationId con MENOS derrotas tambien es 409', async () => {
    await useCase.execute(commandWith())

    await expect(useCase.execute(commandWith({ defeats: [DEFEATS[0]!] }))).rejects.toThrow(
      ExperienceRollOperationReusedError,
    )
  })

  it('la misma lista en distinto ORDEN es un lote distinto: 409', async () => {
    await useCase.execute(commandWith())

    await expect(
      useCase.execute(commandWith({ defeats: [DEFEATS[1]!, DEFEATS[0]!, DEFEATS[2]!] })),
    ).rejects.toThrow(ExperienceRollOperationReusedError)
  })

  it.each([0, 2, '1', undefined, null])(
    'rechaza una schemaVersion que no es la vigente: %s',
    async (schemaVersion) => {
      await expect(
        useCase.execute(commandWith({ schemaVersion: schemaVersion as number })),
      ).rejects.toThrow(InvalidExperienceRollRequestError)

      expect(random.bounds).toEqual([])
      expect(repository.writes).toEqual([])
    },
  )

  it('rechaza un lote VACIO con 400 y no consume azar', async () => {
    await expect(useCase.execute(commandWith({ defeats: [] }))).rejects.toThrow(
      InvalidExperienceRollRequestError,
    )

    expect(random.bounds).toEqual([])
    expect(repository.reads).toEqual([])
  })

  it('rechaza un `defeats` que no es una lista', async () => {
    await expect(
      useCase.execute(commandWith({ defeats: 'no-es-lista' as unknown as [] })),
    ).rejects.toThrow(InvalidExperienceRollRequestError)
  })

  it.each(['operationId', 'enrollmentId', 'simulationId', 'heroId'] as const)(
    'rechaza un %s vacio',
    async (field) => {
      await expect(useCase.execute(commandWith({ [field]: '  ' }))).rejects.toThrow(
        InvalidExperienceRollRequestError,
      )

      expect(random.bounds).toEqual([])
    },
  )

  it.each(['encounterId', 'enemyInstanceId', 'rivalRef'] as const)(
    'rechaza una derrota sin %s',
    async (field) => {
      const broken = { ...DEFEATS[0]!, [field]: '' }

      await expect(useCase.execute(commandWith({ defeats: [broken] }))).rejects.toThrow(
        InvalidExperienceRollRequestError,
      )

      expect(random.bounds).toEqual([])
    },
  )

  it('rechaza una derrota que no es un objeto', async () => {
    await expect(
      useCase.execute(commandWith({ defeats: [null as unknown as never] })),
    ).rejects.toThrow(InvalidExperienceRollRequestError)
  })

  it('la misma INSTANCIA dos veces es 422 y no se deduplica en silencio', async () => {
    await expect(
      useCase.execute(commandWith({ defeats: [DEFEATS[0]!, DEFEATS[0]!] })),
    ).rejects.toThrow(DuplicateDefeatError)

    expect(random.bounds).toEqual([])
    expect(repository.writes).toEqual([])
  })

  it('dos instancias del mismo arquetipo NO son duplicado: son dos recompensas', async () => {
    const result = await useCase.execute(commandWith({ defeats: [DEFEATS[0]!, DEFEATS[1]!] }))

    expect(result.defeats).toHaveLength(2)
  })

  it('un lote invalido no escribe NADA: no queda un lote a medias', async () => {
    await expect(useCase.execute(commandWith({ defeats: [] }))).rejects.toThrow(
      InvalidExperienceRollRequestError,
    )

    expect(repository.stored.size).toBe(0)
  })

  it('funciona igual con el repositorio en memoria real del servicio', async () => {
    const real = new ResolveExperienceRolls(new InMemoryExperienceRollRepository(), random)

    const first = await real.execute(commandWith())
    const replay = await real.execute(commandWith())

    expect(first.applied).toBe(true)
    expect(replay.applied).toBe(false)
    expect(replay.defeats.map((defeat) => defeat.roll)).toEqual(
      first.defeats.map((defeat) => defeat.roll),
    )
  })
})
