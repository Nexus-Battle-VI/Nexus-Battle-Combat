import {
  ExperienceRollMappingError,
  toDocument,
  toSnapshot,
  type ExperienceRollBatchDocument,
} from '../../src/adapters/outbound/persistence/experience-roll-mapping'

/**
 * Traduccion documento <-> instantanea del lote de tiradas (HU-09, Task HU-09.2).
 *
 * Se prueba SIN contenedor porque es pura, y se prueba sobre todo el camino de
 * LECTURA: un documento incoherente -- una tirada fuera del dado, un lote sin
 * derrotas, una fecha ausente -- no debe llegar al caso de uso disfrazado de
 * dato bueno.
 */

const PERSISTED_AT = new Date('2026-10-02T03:00:04.120Z')

const documentWith = (
  overrides: Partial<ExperienceRollBatchDocument> = {},
): ExperienceRollBatchDocument => ({
  _id: 'mission:enr_01JB8Y3K7Q:xp-rolls',
  enrollmentId: 'enr_01JB8Y3K7Q',
  simulationId: 'sim_01JB8Y4B',
  heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
  defeats: [
    {
      encounterId: '1',
      enemyInstanceId: 'sombra-corrompida#1',
      rivalRef: 'sombra-corrompida',
      roll: 5,
      persistedAt: PERSISTED_AT,
    },
  ],
  createdAt: PERSISTED_AT,
  ...overrides,
})

describe('toSnapshot', () => {
  it('traduce el documento del ejemplo del contrato §5.2', () => {
    const snapshot = toSnapshot(
      documentWith({
        defeats: [
          {
            encounterId: '1',
            enemyInstanceId: 'sombra-corrompida#1',
            rivalRef: 'sombra-corrompida',
            roll: 5,
            persistedAt: PERSISTED_AT,
          },
          {
            encounterId: '1',
            enemyInstanceId: 'sombra-corrompida#2',
            rivalRef: 'sombra-corrompida',
            roll: 1,
            persistedAt: PERSISTED_AT,
          },
          {
            encounterId: '5',
            enemyInstanceId: 'guardian-eterno#1',
            rivalRef: 'guardian-eterno',
            roll: 8,
            persistedAt: PERSISTED_AT,
          },
        ],
      }),
    )

    expect(snapshot.operationId).toBe('mission:enr_01JB8Y3K7Q:xp-rolls')
    expect(snapshot.defeats.map((defeat) => defeat.roll)).toEqual([5, 1, 8])
    expect(snapshot.defeats.map((defeat) => defeat.enemyInstanceId)).toEqual([
      'sombra-corrompida#1',
      'sombra-corrompida#2',
      'guardian-eterno#1',
    ])
    expect(snapshot.defeats[0]?.persistedAt).toBe(PERSISTED_AT)
  })

  it('el `_id` del documento ES el operationId del lote (clave de idempotencia)', () => {
    expect(toSnapshot(documentWith()).operationId).toBe('mission:enr_01JB8Y3K7Q:xp-rolls')
  })

  it('rechaza un lote sin derrotas', () => {
    expect(() => toSnapshot(documentWith({ defeats: [] }))).toThrow(ExperienceRollMappingError)
  })

  it('rechaza un `defeats` que no es una lista', () => {
    expect(() => toSnapshot(documentWith({ defeats: 'no-es-lista' as unknown as [] }))).toThrow(
      ExperienceRollMappingError,
    )
  })

  it.each([0, 9, 4.5, -1])('rechaza una tirada fuera del dado: %s', (roll) => {
    expect(() =>
      toSnapshot(
        documentWith({
          defeats: [
            {
              encounterId: '1',
              enemyInstanceId: 'a#1',
              rivalRef: 'a',
              roll,
              persistedAt: PERSISTED_AT,
            },
          ],
        }),
      ),
    ).toThrow(ExperienceRollMappingError)
  })

  it('rechaza una tirada que no es un numero', () => {
    expect(() =>
      toSnapshot(
        documentWith({
          defeats: [
            {
              encounterId: '1',
              enemyInstanceId: 'a#1',
              rivalRef: 'a',
              roll: '5' as unknown as number,
              persistedAt: PERSISTED_AT,
            },
          ],
        }),
      ),
    ).toThrow(ExperienceRollMappingError)
  })

  it('rechaza identificadores vacios, que dejarian la derrota sin identidad', () => {
    expect(() =>
      toSnapshot(
        documentWith({
          defeats: [
            {
              encounterId: '',
              enemyInstanceId: 'a#1',
              rivalRef: 'a',
              roll: 3,
              persistedAt: PERSISTED_AT,
            },
          ],
        }),
      ),
    ).toThrow(ExperienceRollMappingError)

    expect(() => toSnapshot(documentWith({ heroId: '   ' }))).toThrow(ExperienceRollMappingError)
  })

  it('rechaza una derrota sin fecha de persistencia', () => {
    expect(() =>
      toSnapshot(
        documentWith({
          defeats: [
            {
              encounterId: '1',
              enemyInstanceId: 'a#1',
              rivalRef: 'a',
              roll: 3,
              persistedAt: undefined as unknown as Date,
            },
          ],
        }),
      ),
    ).toThrow(ExperienceRollMappingError)
  })

  it('rechaza una derrota que no es un objeto', () => {
    expect(() => toSnapshot(documentWith({ defeats: [null as unknown as never] }))).toThrow(
      ExperienceRollMappingError,
    )
  })
})

describe('toDocument', () => {
  it('es la vuelta atras de toSnapshot: ida y vuelta sin perdida', () => {
    const original = toSnapshot(documentWith())

    expect(toSnapshot(toDocument(original))).toEqual(original)
  })

  it('el `_id` sale del operationId y las derrotas conservan su orden', () => {
    const document = toDocument({
      operationId: 'mission:enr-1:xp-rolls',
      enrollmentId: 'enr-1',
      simulationId: 'sim-1',
      heroId: 'hero-1',
      defeats: [
        {
          encounterId: '1',
          enemyInstanceId: 'b#1',
          rivalRef: 'b',
          roll: 2,
          persistedAt: PERSISTED_AT,
        },
        {
          encounterId: '1',
          enemyInstanceId: 'a#1',
          rivalRef: 'a',
          roll: 7,
          persistedAt: PERSISTED_AT,
        },
      ],
      createdAt: PERSISTED_AT,
    })

    expect(document._id).toBe('mission:enr-1:xp-rolls')
    expect(document.defeats.map((defeat) => defeat.roll)).toEqual([2, 7])
  })
})
