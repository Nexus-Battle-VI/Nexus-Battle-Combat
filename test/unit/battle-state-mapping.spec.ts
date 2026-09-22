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
import { battleWithCombat } from '../fixtures/basic-attack'

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
      'turnStartedAt',
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

describe('battle-room-mapping — snapshot de combate y ataque basico (HU-18, migracion 007)', () => {
  const played = () => {
    const room = battleWithCombat()
    const plan = room.planBasicAttack('a1', 'cmd-1', { teamLabel: 'B', seat: 0 })

    if (plan.kind !== 'ready') {
      throw new Error('se esperaba un plan listo')
    }

    return room.applyBasicAttack(
      plan,
      {
        attackValue: 15,
        defenseValue: 11,
        effective: true,
        effect: 'CRITICAL_DAMAGE',
        percent: 137,
        baseDamage: 5,
      },
      'cmd-1',
      LATER,
    )
  }

  it('el documento guarda el snapshot y la Vida actual junto a la cola', () => {
    const document = toDocument(battleWithCombat().toSnapshot())

    expect(Object.keys(document.battle ?? {}).sort()).toEqual([
      'combatants',
      'startedAt',
      'turnOrder',
      'turnStartedAt',
      'turnsCompleted',
    ])
    expect(document.battle?.combatants).toHaveLength(2)
    expect(document.battle?.combatants?.[0]).toMatchObject({
      teamLabel: 'A',
      seat: 0,
      currentHealth: 44,
      profile: { maxHealth: 44, attack: 10, defense: 11 },
    })
  })

  it('tras un ataque: snapshot -> documento -> snapshot conserva Vida, evento, comando y turno', () => {
    const after = played()
    const document = toDocument(after.toSnapshot())
    const restored = BattleRoom.restore(toSnapshot(document))

    expect(document.battle?.combatants?.[1]?.currentHealth).toBe(38)
    expect(document.events?.map((event) => [event.seq, event.type])).toEqual([
      [1, 'battleStarted'],
      [2, 'basicAttackResolved'],
    ])
    expect(document.handledCommands).toEqual([{ commandId: 'cmd-1', seq: 2 }])
    expect(restored.toSnapshot()).toEqual(after.toSnapshot())
    expect(restored.battleView()).toEqual(after.battleView())
  })

  it('un documento de HU-17 (sin combatants) se restaura SIN error, sin Vida y sin consultar a nadie', () => {
    const document = { ...toDocument(inBattleRoom().toSnapshot()) }
    const restored = BattleRoom.restore(toSnapshot(document))

    expect(restored.status).toBe('IN_BATTLE')
    expect(restored.battle?.combatants).toBeNull()
    expect(restored.battleView()?.combatants).toEqual([])
  })

  it('una batalla anterior a HU-18 NO se reescribe con combatants inventados al guardar', () => {
    const document = toDocument(inBattleRoom().toSnapshot())

    expect(document.battle).not.toHaveProperty('combatants')
  })

  it('un snapshot corrupto (Vida mayor que la maxima) se rechaza al restaurar', () => {
    const document = toDocument(battleWithCombat().toSnapshot())
    const corrupt = {
      ...document,
      battle: {
        ...document.battle,
        combatants: (document.battle?.combatants ?? []).map((combatant, index) =>
          index === 0 ? { ...combatant, currentHealth: 999 } : combatant,
        ),
      },
    }

    expect(() => BattleRoom.restore(toSnapshot(corrupt as unknown as BattleRoomDocument))).toThrow()
  })

  it('el documento es JSON puro y no guarda inventario, nombre del heroe ni fecha de seleccion', () => {
    const serialized = JSON.stringify(toDocument(played().toSnapshot()).battle?.combatants)

    expect(serialized).not.toMatch(/selectedAt|baseStats|blockers|loadoutVersion|seed|semilla/i)
    expect(() => JSON.parse(serialized) as unknown).not.toThrow()
  })
})
