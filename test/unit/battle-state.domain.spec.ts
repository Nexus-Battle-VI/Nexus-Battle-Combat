import { BattleRoom, type RestorableBattleRoomSnapshot } from '../../src/domain/entities/BattleRoom'
import { BattleState } from '../../src/domain/entities/BattleState'
import { DomainError } from '../../src/domain/errors/DomainError'
import {
  BattleNotInProgressError,
  InvalidBattleRosterError,
  InvalidCommandIdError,
  NotYourTurnError,
  RoomNotStartableError,
} from '../../src/domain/errors/BattleErrors'
import { RoomNotLeavableError } from '../../src/domain/errors/BattleRoomErrors'
import { NOW, ROOM_ID, inBattleRoom, labels, memberOf, preparingRoom } from '../fixtures/battle'
import { battleWithCombat, combatProfileFixture } from '../fixtures/basic-attack'

const LATER = new Date('2026-09-21T10:05:00.000Z')

describe('BattleState — cola inmutable y unico contador de progreso (HU-17)', () => {
  const order = [memberOf('B', 0), memberOf('A', 0)]

  it('empieza con turnsCompleted = 0: posicion 0, ronda 1 y turno activo = primero de la cola', () => {
    const state = BattleState.start(order, NOW)

    expect(state.turnsCompleted).toBe(0)
    expect(state.currentPosition).toBe(0)
    expect(state.round).toBe(1)
    expect(state.currentEntry.teamLabel).toBe('B')
  })

  it('avanzar pasa al siguiente elemento y, tras el ultimo, VUELVE al primero (rondas siguientes)', () => {
    const first = BattleState.start(order, NOW)
    const second = first.completeTurn(LATER)
    const third = second.completeTurn(LATER)

    expect([first, second, third].map((state) => state.currentPosition)).toEqual([0, 1, 0])
    expect([first, second, third].map((state) => state.round)).toEqual([1, 1, 2])
  })

  it('el orden NO cambia al avanzar: misma cola, misma referencia, mismo contenido', () => {
    const first = BattleState.start(order, NOW)
    const later = first.completeTurn(LATER).completeTurn(LATER).completeTurn(LATER)

    expect(later.turnOrder).toBe(first.turnOrder)
    expect(labels(later.turnOrder)).toEqual(['B1', 'A1'])
  })

  it('no hay nuevo sorteo por ronda: en 30 turnos la secuencia de actores es periodica', () => {
    let state = BattleState.start([memberOf('A', 0), memberOf('B', 0), memberOf('A', 1)], NOW)
    const actors: string[] = []

    for (let turn = 0; turn < 30; turn += 1) {
      actors.push(`${state.currentEntry.teamLabel}${String(state.currentEntry.seat + 1)}`)
      state = state.completeTurn(LATER)
    }

    expect(actors.slice(0, 3)).toEqual(['A1', 'B1', 'A2'])
    expect(actors).toEqual(Array.from({ length: 30 }, (_, index) => actors[index % 3]))
  })

  it('la cola es inmutable: no se puede reordenar ni mutar un participante', () => {
    const state = BattleState.start(order, NOW)

    expect(Object.isFrozen(state.turnOrder)).toBe(true)
    expect(Object.isFrozen(state.turnOrder[0])).toBe(true)
    expect(() => {
      ;(state.turnOrder as unknown as unknown[]).reverse()
    }).toThrow(TypeError)
  })

  it('posicion y ronda se DERIVAN de turnsCompleted: no hay otro estado que pueda divergir', () => {
    const state = BattleState.restore({ startedAt: NOW, turnOrder: order, turnsCompleted: 7 })

    expect(state.currentPosition).toBe(1)
    expect(state.round).toBe(4)
    expect(Object.keys(state.toSnapshot()).sort()).toEqual([
      'combatants',
      'startedAt',
      'turnOrder',
      'turnStartedAt',
      'turnsCompleted',
    ])
  })

  it('la vista lleva posiciones, ronda y turno actual, y NADA interno (sin semilla ni sorteos)', () => {
    const view = BattleState.start(order, NOW).toView(ROOM_ID)

    expect(view.battleId).toBe(ROOM_ID)
    expect(view.turnOrder.map((entry) => entry.position)).toEqual([0, 1])
    expect(view.currentTurn.position).toBe(0)
    expect(Object.keys(view).sort()).toEqual([
      'battleId',
      'combatants',
      'currentTurn',
      'deadlines',
      'round',
      'startedAt',
      'turnOrder',
      'turnsCompleted',
    ])
    expect(JSON.stringify(view)).not.toMatch(/seed|semilla|draw|random/i)
  })

  describe('validacion de la cola', () => {
    it.each([
      ['menos de dos participantes', [memberOf('A', 0)]],
      [
        'mas de seis participantes',
        Array.from({ length: 7 }, (_, seat) => memberOf(seat % 2 === 0 ? 'A' : 'B', seat)),
      ],
      ['participante duplicado', [memberOf('A', 0), memberOf('A', 0, { playerId: 'x' })]],
      ['jugador repetido', [memberOf('A', 0), memberOf('B', 0, { playerId: 'a1' })]],
      ['HUMAN sin jugador', [memberOf('A', 0, { playerId: null }), memberOf('B', 0)]],
      ['AI con jugador', [memberOf('A', 0, { kind: 'AI' }), memberOf('B', 0)]],
    ])('rechaza %s', (_case, entries) => {
      expect(() => BattleState.start(entries, NOW)).toThrow(InvalidBattleRosterError)
    })

    it('rechaza una fecha de inicio invalida y un contador negativo o no entero', () => {
      expect(() => BattleState.start(order, new Date('x'))).toThrow(DomainError)
      expect(() =>
        BattleState.restore({ startedAt: NOW, turnOrder: order, turnsCompleted: -1 }),
      ).toThrow(DomainError)
      expect(() =>
        BattleState.restore({ startedAt: NOW, turnOrder: order, turnsCompleted: 1.5 }),
      ).toThrow(DomainError)
    })
  })
})

describe('BattleRoom.startBattle — PREPARING -> IN_BATTLE (HU-17)', () => {
  const orderOf = (room: BattleRoom): ReturnType<typeof memberOf>[] => {
    const [a, b] = room.roster()

    return [
      ...b.members.map((m) => ({ ...m, heroSubtype: 'MAGO_FUEGO' })),
      ...a.members.map((m) => ({ ...m, heroSubtype: 'MAGO_HIELO' })),
    ]
  }

  it('inicia: estado IN_BATTLE, batalla creada y battleStarted con seq 1', () => {
    const room = preparingRoom()
    const started = room.startBattle(orderOf(room), LATER)

    expect(started.status).toBe('IN_BATTLE')
    expect(started.battle?.turnsCompleted).toBe(0)
    expect(started.lastSeq).toBe(1)
    expect(started.events).toHaveLength(1)
    expect(started.events[0]).toMatchObject({ seq: 1, type: 'battleStarted', occurredAt: LATER })
    expect(started.version).toBe(room.version)
  })

  it('el evento persiste la MISMA vista que ve el cliente (sin recalcular despues)', () => {
    const room = preparingRoom()
    const started = room.startBattle(orderOf(room), LATER)

    expect(started.events[0]?.payload.battle).toEqual(started.battleView())
  })

  it('el roster es definitivo: la cola debe contener exactamente a los participantes de la sala', () => {
    const room = preparingRoom({ teamSizes: [2, 2] })
    const complete = orderOf(room)

    expect(() => room.startBattle(complete.slice(1), NOW)).toThrow(InvalidBattleRosterError)
    expect(() =>
      room.startBattle([...complete, memberOf('A', 5, { playerId: 'intruso' })], NOW),
    ).toThrow(InvalidBattleRosterError)
    expect(() =>
      room.startBattle(
        complete.map((entry, index) => (index === 0 ? { ...entry, playerId: 'intruso' } : entry)),
        NOW,
      ),
    ).toThrow(InvalidBattleRosterError)
  })

  it.each([
    [
      'WAITING_FOR_PLAYERS',
      () =>
        BattleRoom.create(
          ROOM_ID,
          'a1',
          { mode: 'PVP', teamConfigs: [{ capacity: 1 }, { capacity: 1 }], reward: { amount: 0 } },
          NOW,
        ),
    ],
    ['IN_BATTLE (segunda inicializacion)', () => inBattleRoom()],
  ])('no se puede iniciar desde %s', (_status, build) => {
    const room = build()

    expect(() => room.startBattle(orderOf(preparingRoom()), NOW)).toThrow(RoomNotStartableError)
  })

  it('con cupo incompleto no hay cola (una sala que perdio un jugador no llega a iniciar)', () => {
    const room = preparingRoom().leave('b1')

    expect(room.status).toBe('WAITING_FOR_PLAYERS')
    expect(() => room.startBattle(orderOf(preparingRoom()), NOW)).toThrow(RoomNotStartableError)
  })

  it('en batalla la lista es definitiva: nadie puede abandonar, unirse ni cancelar', () => {
    const room = inBattleRoom()

    expect(() => room.leave('a1')).toThrow(RoomNotLeavableError)
    expect(() => room.join('nuevo', null, NOW)).toThrow(DomainError)
    expect(() => room.cancel('a1')).toThrow(DomainError)
  })
})

describe('BattleRoom.completeTurn — avance server-side (HU-17)', () => {
  it('solo el participante de la posicion activa puede cerrar su turno', () => {
    const room = inBattleRoom()
    const active = room.battle?.currentEntry.playerId ?? ''
    const other = active === 'a1' ? 'b1' : 'a1'

    expect(() => room.completeTurn(other, 'c-1', LATER)).toThrow(NotYourTurnError)
    expect(() => room.completeTurn(null, 'c-1', LATER)).toThrow(NotYourTurnError)
    expect(() => room.completeTurn('intruso', 'c-1', LATER)).toThrow(NotYourTurnError)
  })

  it('cerrar el turno avanza al siguiente y registra turnAdvanced con seq creciente', () => {
    const room = inBattleRoom()
    const first = room.battle?.currentEntry.playerId ?? ''
    const next = room.completeTurn(first, 'c-1', LATER)

    expect(next).not.toBe(room)
    expect(next.battle?.turnsCompleted).toBe(1)
    expect(next.battle?.currentEntry.playerId).not.toBe(first)
    expect(next.lastSeq).toBe(2)
    expect(next.events[1]).toMatchObject({ seq: 2, type: 'turnAdvanced', occurredAt: LATER })
    expect(next.events[1]?.payload).toMatchObject({ completedPosition: 0 })
    expect(next.events[0]).toBe(room.events[0])
  })

  it('el original no cambia (agregado inmutable) y la cola tampoco', () => {
    const room = inBattleRoom()
    const before = labels(room.battle?.turnOrder ?? [])

    room.completeTurn(room.battle?.currentEntry.playerId ?? '', 'c-1', LATER)

    expect(room.battle?.turnsCompleted).toBe(0)
    expect(labels(room.battle?.turnOrder ?? [])).toEqual(before)
  })

  it('un commandId repetido devuelve LA MISMA instancia: no avanza dos veces ni crea otro evento', () => {
    const room = inBattleRoom()
    const first = room.completeTurn(room.battle?.currentEntry.playerId ?? '', 'c-1', LATER)
    const repeated = first.completeTurn('cualquiera', 'c-1', LATER)

    expect(repeated).toBe(first)
    expect(repeated.lastSeq).toBe(2)
  })

  it('un commandId nuevo del siguiente participante avanza otra vez y vuelve al primero', () => {
    let room = inBattleRoom()
    const sequence: string[] = []

    for (let turn = 0; turn < 4; turn += 1) {
      const actor = room.battle?.currentEntry.playerId ?? ''

      sequence.push(actor)
      room = room.completeTurn(actor, `c-${String(turn)}`, LATER)
    }

    expect(sequence[0]).toBe(sequence[2])
    expect(sequence[1]).toBe(sequence[3])
    expect(sequence[0]).not.toBe(sequence[1])
    expect(room.lastSeq).toBe(5)
  })

  it('un turno de AI lo cierra el servidor (actor null) y un humano no puede cerrarlo', () => {
    const room = inBattleRoom({ teamSizes: [1, 1], aiInTeamB: 1 })
    let current = room

    // Avanza hasta un turno de AI.
    if (current.battle?.currentEntry.kind === 'HUMAN') {
      current = current.completeTurn(current.battle.currentEntry.playerId, 'c-h', LATER)
    }

    expect(current.battle?.currentEntry.kind).toBe('AI')
    expect(() => current.completeTurn('a1', 'c-x', LATER)).toThrow(NotYourTurnError)
    expect(current.completeTurn(null, 'c-ai', LATER).battle?.turnsCompleted).toBe(2)
  })

  it.each(['', '   ', 'x'.repeat(101)])(
    'commandId invalido (%p) -> InvalidCommandIdError',
    (commandId) => {
      const room = inBattleRoom()

      expect(() =>
        room.completeTurn(room.battle?.currentEntry.playerId ?? '', commandId, NOW),
      ).toThrow(InvalidCommandIdError)
    },
  )

  it('sin batalla en curso no hay turno que cerrar', () => {
    expect(() => preparingRoom().completeTurn('a1', 'c-1', NOW)).toThrow(BattleNotInProgressError)
  })
})

describe('BattleRoom — restauracion y consultas de la batalla', () => {
  it('snapshot -> restore conserva batalla, eventos y comandos', () => {
    const started = inBattleRoom()
    const advanced = started.completeTurn(started.battle?.currentEntry.playerId ?? '', 'c-1', LATER)
    const restored = BattleRoom.restore(advanced.toSnapshot())

    expect(restored.toSnapshot()).toEqual(advanced.toSnapshot())
    expect(restored.battleView()).toEqual(advanced.battleView())
    expect(restored.handledCommands).toEqual([{ commandId: 'c-1', seq: 2 }])
  })

  it('una instantanea anterior a HU-17 (sin campos de batalla) se restaura como sala sin batalla', () => {
    const legacy: Record<string, unknown> = { ...preparingRoom().toSnapshot() }

    for (const key of ['battle', 'events', 'handledCommands']) {
      Reflect.deleteProperty(legacy, key)
    }

    const restored = BattleRoom.restore(legacy as unknown as RestorableBattleRoomSnapshot)

    expect(restored.battle).toBeNull()
    expect(restored.events).toEqual([])
    expect(restored.lastSeq).toBe(0)
    expect(restored.battleView()).toBeNull()
  })

  it('rechaza incoherencias: IN_BATTLE sin batalla, batalla en otra sala, o bitacora con huecos', () => {
    const base = inBattleRoom().toSnapshot()

    expect(() => BattleRoom.restore({ ...base, battle: null })).toThrow(DomainError)
    expect(() =>
      BattleRoom.restore({ ...preparingRoom().toSnapshot(), battle: base.battle }),
    ).toThrow(DomainError)
    expect(() =>
      BattleRoom.restore({ ...base, events: base.events.map((event) => ({ ...event, seq: 3 })) }),
    ).toThrow(DomainError)
  })

  it('eventsAfter devuelve los posteriores en orden y isParticipant reconoce solo a los HUMAN de la sala', () => {
    let room = inBattleRoom()

    room = room.completeTurn(room.battle?.currentEntry.playerId ?? '', 'c-1', LATER)
    room = room.completeTurn(room.battle?.currentEntry.playerId ?? '', 'c-2', LATER)

    expect(room.eventsAfter(1).map((event) => event.seq)).toEqual([2, 3])
    expect(room.eventsAfter(3)).toEqual([])
    expect(room.eventsAfter(0).map((event) => event.seq)).toEqual([1, 2, 3])
    expect(room.isParticipant('a1')).toBe(true)
    expect(room.isParticipant('intruso')).toBe(false)
  })

  it('roster(): lista definitiva por equipo sin estadisticas ni equipamiento', () => {
    const [a, b] = preparingRoom({ teamSizes: [2, 1] }).roster()

    expect(a.members.map((member) => member.playerId)).toEqual(['a1', 'a2'])
    expect(b.members.map((member) => member.playerId)).toEqual(['b1'])
    expect(Object.keys(a.members[0] ?? {}).sort()).toEqual([
      'displayName',
      'heroId',
      'heroSubtype',
      'kind',
      'playerId',
      'seat',
      'teamLabel',
    ])
  })
})

describe('BattleState - HU-21: turno vigente, saltos, Poder y deadlines (contrato §3, §4.1 y §6.3)', () => {
  it('el turno arranca con la batalla y se renueva con el instante de cada avance', () => {
    const started = BattleState.start([memberOf('A', 0), memberOf('B', 0)], NOW)

    expect(started.turnStartedAt).toEqual(NOW)

    const advanced = started.completeTurn(LATER)

    expect(advanced.turnStartedAt).toEqual(LATER)
  })

  it('una batalla anterior a HU-21 (sin `turnStartedAt`) lo restaura desde `startedAt`', () => {
    const state = BattleState.restore({
      startedAt: NOW,
      turnOrder: [memberOf('A', 0), memberOf('B', 0)],
      turnsCompleted: 1,
    })

    expect(state.turnStartedAt).toEqual(NOW)
    expect(state.toSnapshot().turnStartedAt).toEqual(NOW)
  })

  it('la vista trae los deadlines (turno y global) y la final los omite', () => {
    const state = BattleState.start([memberOf('A', 0), memberOf('B', 0)], NOW)
    const view = state.toView('sala')

    expect(view.deadlines).toEqual({
      turnEndsAt: new Date(NOW.getTime() + 30_000).toISOString(),
      battleEndsAt: new Date(NOW.getTime() + 360_000).toISOString(),
    })
    expect(state.toView('sala', { withDeadlines: false }).deadlines).toBeUndefined()
  })

  it('el avance SALTA a quien no tiene Vida y suma cada posicion saltada', () => {
    const room = battleWithCombat({ teamSizes: [2, 2], health: { 'B#0': 0 } })
    const state = room.battle

    if (state === null) {
      throw new Error('La sala de prueba necesita batalla.')
    }

    // Cola A0, B0, A1, B1: B0 esta eliminado, asi que de A0 se pasa a A1.
    const advanced = state.completeTurn(LATER)

    expect(advanced.turnsCompleted).toBe(2)
    expect(advanced.currentEntry).toMatchObject({ teamLabel: 'A', seat: 1 })
  })

  it('sin nadie con Vida lanza DomainError (la batalla ya deberia haber finalizado)', () => {
    const room = battleWithCombat({ health: { 'A#0': 0, 'B#0': 0 } })
    const state = room.battle

    if (state === null) {
      throw new Error('La sala de prueba necesita batalla.')
    }

    expect(() => state.completeTurn(LATER)).toThrow(DomainError)
  })

  it('restoreAllPower deja el Poder al maximo y conserva la instancia si no hay nada que restaurar', () => {
    const room = battleWithCombat({
      profiles: {
        a1: combatProfileFixture({ maxPower: 10 }),
        b1: combatProfileFixture({ maxPower: 10 }),
      },
    })
    const state = room.battle

    if (state === null) {
      throw new Error('La sala de prueba necesita batalla.')
    }

    expect(state.restoreAllPower()).toBe(state)

    const drained = state.withCombatant(
      (() => {
        const combatant = state.combatantFor({ teamLabel: 'A', seat: 0 })

        if (combatant === undefined) {
          throw new Error('sin combatiente')
        }

        return combatant.withPower(2)
      })(),
    )
    const restored = drained.restoreAllPower()

    expect(restored.combatantFor({ teamLabel: 'A', seat: 0 })?.currentPower).toBe(10)
    expect(restored).not.toBe(drained)
  })

  it.each([
    ['A', 0],
    ['B', 1],
  ] as const)(
    'sin snapshot de combate no hay saltos ni Poder que restaurar (%s#%i)',
    (label, seat) => {
      const room = battleWithCombat({ withCombat: false })
      const state = room.battle

      if (state === null) {
        throw new Error('La sala de prueba necesita batalla.')
      }

      // Sin combatientes, el avance es el de siempre: una posicion por llamada.
      expect(state.completeTurn(LATER).turnsCompleted).toBe(1)
      expect(state.restoreAllPower()).toBe(state)
      expect(state.combatantFor({ teamLabel: label, seat })).toBeUndefined()
    },
  )
})
