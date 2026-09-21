import { Int32 } from 'mongodb'

import {
  toDocument,
  toSnapshot,
  type BattleRoomDocument,
} from '../../src/adapters/outbound/persistence/battle-room-mapping'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import {
  DEFAULT_RANDOM_SEED,
  ConfigurationError,
  loadConfig,
} from '../../src/infrastructure/config/env'
import { inBattleRoom, preparingRoom } from '../fixtures/battle'

const LATER = new Date('2026-09-21T10:05:00.000Z')

describe('battle-room-mapping — batalla, eventos y comandos (HU-17, migracion 005)', () => {
  it('un documento anterior a HU-17 (sin battle, events ni handledCommands) se restaura sin batalla', () => {
    const legacy: Record<string, unknown> = { ...toDocument(preparingRoom().toSnapshot()) }

    for (const key of ['battle', 'events', 'handledCommands']) {
      Reflect.deleteProperty(legacy, key)
    }

    const restored = BattleRoom.restore(toSnapshot(legacy as unknown as BattleRoomDocument))

    expect(restored.status).toBe('PREPARING')
    expect(restored.battle).toBeNull()
    expect(restored.events).toEqual([])
    expect(restored.handledCommands).toEqual([])
  })

  it('sala en batalla: snapshot -> documento -> snapshot conserva cola, contador, eventos y comandos', () => {
    const started = inBattleRoom({ teamSizes: [2, 2] })
    const advanced = started.completeTurn(started.battle?.currentEntry.playerId ?? '', 'c-1', LATER)
    const document = toDocument(advanced.toSnapshot())
    const restored = BattleRoom.restore(toSnapshot(document))

    expect(document.status).toBe('IN_BATTLE')
    expect(document.events?.map((event) => event.seq)).toEqual([1, 2])
    expect(document.handledCommands).toEqual([{ commandId: 'c-1', seq: 2 }])
    expect(restored.toSnapshot()).toEqual(advanced.toSnapshot())
  })

  it('el documento guarda la cola COMPLETA y el contador; posicion y ronda no se persisten', () => {
    const document = toDocument(inBattleRoom().toSnapshot())

    expect(Object.keys(document.battle ?? {}).sort()).toEqual([
      'startedAt',
      'turnOrder',
      'turnsCompleted',
    ])
    expect(document.battle?.turnOrder).toHaveLength(2)
  })

  it('el evento persistido es JSON puro (sin semilla ni estado del generador)', () => {
    const document = toDocument(inBattleRoom().toSnapshot())
    const serialized = JSON.stringify(document.events)

    expect(() => JSON.parse(serialized) as unknown).not.toThrow()
    expect(serialized).not.toMatch(/seed|semilla|mt19937|draw/i)
  })

  it('acepta enteros de BSON (Int32) en seq y turnsCompleted al leer', () => {
    const document = toDocument(inBattleRoom().toSnapshot())
    const withInt32: BattleRoomDocument = {
      ...document,
      battle:
        document.battle === undefined || document.battle === null
          ? null
          : { ...document.battle, turnsCompleted: new Int32(0) },
      events: document.events?.map((event) => ({ ...event, seq: new Int32(Number(event.seq)) })),
    }

    expect(toSnapshot(withInt32).battle?.turnsCompleted).toBe(0)
    expect(toSnapshot(withInt32).events[0]?.seq).toBe(1)
  })

  it('rechaza un contador o un seq corruptos (negativo)', () => {
    const document = toDocument(inBattleRoom().toSnapshot())

    expect(() =>
      toSnapshot({
        ...document,
        battle:
          document.battle === undefined || document.battle === null
            ? null
            : { ...document.battle, turnsCompleted: -1 },
      }),
    ).toThrow()
    expect(() =>
      toSnapshot({ ...document, events: document.events?.map((event) => ({ ...event, seq: -1 })) }),
    ).toThrow()
  })
})

describe('configuracion de la semilla de arranque (HU-17, semilla validada por HU-26)', () => {
  it('por defecto es 3.000.000 (semilla validada por HU-26)', () => {
    expect(DEFAULT_RANDOM_SEED).toBe(3_000_000)
    expect(loadConfig({}).randomSeed).toBe(3_000_000)
  })

  it('COMBAT_RANDOM_SEED la sustituye y acepta el rango uint32', () => {
    expect(loadConfig({ COMBAT_RANDOM_SEED: '42' }).randomSeed).toBe(42)
    expect(loadConfig({ COMBAT_RANDOM_SEED: '0' }).randomSeed).toBe(0)
    expect(loadConfig({ COMBAT_RANDOM_SEED: '4294967295' }).randomSeed).toBe(4_294_967_295)
  })

  it.each(['-1', '4294967296', '1.5', 'abc'])(
    'COMBAT_RANDOM_SEED=%s se rechaza al arrancar',
    (value) => {
      expect(() => loadConfig({ COMBAT_RANDOM_SEED: value })).toThrow(ConfigurationError)
    },
  )
})
