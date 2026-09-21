import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../src/application/errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import {
  ExecuteBasicAttack,
  type ExecuteBasicAttackInput,
} from '../../src/application/use-cases/ExecuteBasicAttack'
import { BattleEventType } from '../../src/domain/entities/BattleEvent'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  InvalidCommandIdError,
  InvalidTargetError,
  NotYourTurnError,
  SameTeamTargetError,
  TargetUnavailableError,
  UnsupportedCombatProfileError,
} from '../../src/domain/errors/BattleErrors'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { ROOM_ID, clock, scriptedSequence } from '../fixtures/battle'
import {
  battleWithCombat,
  combatProfileFixture,
  healthOf,
  indexForEffect,
  indexForFace,
  type BattleWithCombatOptions,
} from '../fixtures/basic-attack'

/**
 * Ataque basico de extremo a extremo en la capa de aplicacion (HU-18), con la
 * secuencia HU-24 GUIONIZADA: cada sorteo se conoce y se cuenta.
 *
 * Perfil por defecto: Guerrero Armas de la Tabla 6 (Vida 44, Ataque 10 + 1d6, Defensa
 * 11, Dano 1d6). Con Defensa 11, una cara 1 iguala (10 + 1 = 11, NO supera) y de la 2
 * en adelante supera.
 */
const ARMAS = 'GUERRERO_ARMAS'
const TARGET = { teamLabel: 'B', seat: 0 } as const

const attackDie = (face: number): number => indexForFace(face, 6)
const damageDie = (face: number, sides = 6): number => indexForFace(face, sides)
const effect = (kind: RandomEffectType, percent?: number, subtype = ARMAS): number =>
  indexForEffect(subtype, kind, percent)

const command = (overrides: Partial<ExecuteBasicAttackInput> = {}): ExecuteBasicAttackInput => ({
  roomId: ROOM_ID,
  requesterId: 'a1',
  commandId: 'cmd-1',
  target: TARGET,
  ...overrides,
})

const setup = async (
  options: BattleWithCombatOptions = {},
  indices: readonly number[] = [],
  wrap: (repo: BattleRoomRepositoryPort) => BattleRoomRepositoryPort = (repo) => repo,
) => {
  const inner = new InMemoryBattleRoomRepository()

  await inner.save(battleWithCombat(options), 0)

  const sequence = scriptedSequence(indices)
  const repo = wrap(inner)
  const useCase = new ExecuteBasicAttack(repo, clock, sequence, new ChannelLock())
  const room = async () => {
    const found = await inner.findById(ROOM_ID)

    if (found === null) {
      throw new Error('la sala desaparecio')
    }

    return found
  }

  return { inner, useCase, sequence, room }
}

describe('ExecuteBasicAttack — flujo principal (CA-01, CA-05, CA-06, CA-07)', () => {
  it('ataque -> resolucion -> Vida -> fin de turno, en UNA ejecucion y UNA escritura', async () => {
    // Dado de Ataque 5 (10 + 5 = 15 > 11), causar dano (100 %), dado de Dano 4.
    const { useCase, sequence, room, inner } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])
    const before = await room()

    const result = await useCase.execute(command())
    const after = await room()

    expect(result.replayed).toBe(false)
    expect(result.event).toMatchObject({ seq: 2, type: BattleEventType.BasicAttackResolved })
    expect(result.event.payload).toMatchObject({
      resolution: {
        attackValue: 15,
        defenseValue: 11,
        effective: true,
        effect: 'DAMAGE',
        percent: 100,
        baseDamage: 4,
        calculatedDamage: 4,
        appliedDamage: 4,
      },
      targetHealth: { before: 44, after: 40 },
    })
    expect(sequence.consumed()).toBe(3)
    // Vida y turno cambiaron JUNTOS en UNA sola version nueva del agregado.
    expect(healthOf(after, 'B')).toEqual({ current: 40, max: 44 })
    expect(after.battle?.turnsCompleted).toBe(1)
    expect(after.battleView()?.currentTurn.playerId).toBe('b1')
    expect(after.version).toBe(before.version + 1)
    expect(after.lastSeq).toBe(2)
    expect(after.handledCommands).toEqual([{ commandId: 'cmd-1', seq: 2 }])
    // El evento persistido es exactamente el que se devuelve.
    expect(after.events.at(-1)).toEqual(result.event)
    expect(await inner.findById(ROOM_ID)).not.toBeNull()
  })

  it('el orden de los sorteos es: dado de Ataque, efecto, dado de Dano', async () => {
    // Si el orden fuera otro, la cara de Ataque (5) o el efecto (critico 137 %) no coincidirian.
    const { useCase, sequence } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.CriticalDamage, 137),
      damageDie(5),
    ])

    const { event } = await useCase.execute(command())

    expect(event.payload).toMatchObject({
      resolution: { attackValue: 15, effect: 'CRITICAL_DAMAGE', percent: 137, baseDamage: 5 },
    })
    expect(sequence.consumed()).toBe(3)
  })

  it('critico 137 % sobre dano base 5: floor(6,85) = 6, Vida 44 -> 38', async () => {
    const { useCase, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.CriticalDamage, 137),
      damageDie(5),
    ])

    await useCase.execute(command())

    expect(healthOf(await room(), 'B')).toEqual({ current: 38, max: 44 })
  })

  it.each([
    [RandomEffectType.Damage, undefined, 100, 5, 5],
    [RandomEffectType.Evade, undefined, 80, 5, 4],
    [RandomEffectType.Escape, undefined, 20, 5, 1],
    [RandomEffectType.Escape, undefined, 20, 3, 0],
    [RandomEffectType.CriticalDamage, 120, 120, 5, 6],
    [RandomEffectType.CriticalDamage, 180, 180, 5, 9],
  ])(
    'efecto %s (%i %%) sobre dano base %i -> dano floor = %i',
    async (kind, requested, percent, base, expected) => {
      const { useCase, room } = await setup({}, [
        attackDie(5),
        effect(kind, requested),
        damageDie(base),
      ])

      const { event } = await useCase.execute(command())

      expect(event.payload).toMatchObject({ resolution: { percent, calculatedDamage: expected } })
      expect(healthOf(await room(), 'B')?.current).toBe(44 - expected)
    },
  )

  it('RESIST (60 %) con un Mago de Fuego: floor(5 x 0,6) = 3', async () => {
    const mago = combatProfileFixture({
      subtype: 'MAGO_FUEGO',
      damage: { mode: 'DICE', count: 1, sides: 8 },
    })
    const { useCase, room } = await setup({ profiles: { a1: mago } }, [
      indexForFace(5, 8),
      effect(RandomEffectType.Resist, undefined, 'MAGO_FUEGO'),
      damageDie(5, 8),
    ])

    const { event } = await useCase.execute(command())

    expect(event.payload).toMatchObject({ resolution: { percent: 60, calculatedDamage: 3 } })
    expect(healthOf(await room(), 'B')?.current).toBe(41)
  })

  it('efecto NO_DAMAGE (0 %): consume solo Ataque y efecto, la Vida no cambia y el turno AVANZA', async () => {
    const { useCase, sequence, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.NoDamage),
    ])

    const { event } = await useCase.execute(command())
    const after = await room()

    expect(sequence.consumed()).toBe(2)
    expect(event.payload).toMatchObject({
      resolution: {
        effective: true,
        effect: 'NO_DAMAGE',
        percent: 0,
        baseDamage: null,
        calculatedDamage: 0,
        appliedDamage: 0,
      },
    })
    expect(healthOf(after, 'B')).toEqual({ current: 44, max: 44 })
    expect(after.battle?.turnsCompleted).toBe(1)
  })

  it('golpe NO efectivo: consume SOLO el dado de Ataque, Vida igual, el turno AVANZA', async () => {
    // Cara 1: 10 + 1 = 11, igual a la Defensa 11: la igualdad NO supera.
    const { useCase, sequence, room } = await setup({}, [attackDie(1)])

    const { event } = await useCase.execute(command())
    const after = await room()

    expect(sequence.consumed()).toBe(1)
    expect(event.payload).toMatchObject({
      resolution: {
        attackValue: 11,
        defenseValue: 11,
        effective: false,
        effect: null,
        percent: null,
        baseDamage: null,
        calculatedDamage: 0,
        appliedDamage: 0,
      },
      targetHealth: { before: 44, after: 44 },
    })
    expect(healthOf(after, 'B')).toEqual({ current: 44, max: 44 })
    expect(after.battle?.turnsCompleted).toBe(1)
  })

  it('un Ataque un punto por encima de la Defensa SI es efectivo (frontera)', async () => {
    const { useCase } = await setup({}, [attackDie(2), effect(RandomEffectType.NoDamage)])

    const { event } = await useCase.execute(command())

    expect(event.payload).toMatchObject({ resolution: { attackValue: 12, effective: true } })
  })

  it('overkill: la Vida queda en 0, nunca negativa; se conserva el dano calculado', async () => {
    const { useCase, room } = await setup({ health: { 'B#0': 3 } }, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(6),
    ])

    const { event } = await useCase.execute(command())

    expect(event.payload).toMatchObject({
      resolution: { calculatedDamage: 6, appliedDamage: 3 },
      targetHealth: { before: 3, after: 0 },
    })
    expect(healthOf(await room(), 'B')).toEqual({ current: 0, max: 44 })
  })

  it('Dano FIXED: se usa tal cual, SIN sorteo de dano', async () => {
    const fixed = combatProfileFixture({ damage: { mode: 'FIXED', amount: 4 } })
    const { useCase, sequence, room } = await setup({ profiles: { a1: fixed } }, [
      attackDie(5),
      effect(RandomEffectType.Damage),
    ])

    const { event } = await useCase.execute(command())

    expect(sequence.consumed()).toBe(2)
    expect(event.payload).toMatchObject({ resolution: { baseDamage: 4, calculatedDamage: 4 } })
    expect(healthOf(await room(), 'B')?.current).toBe(40)
  })

  it('Dano en varios dados (2d6): consume exactamente `count` indices', async () => {
    const dos = combatProfileFixture({ damage: { mode: 'DICE', count: 2, sides: 6 } })
    const { useCase, sequence } = await setup({ profiles: { a1: dos } }, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(3),
      damageDie(4),
    ])

    const { event } = await useCase.execute(command())

    expect(sequence.consumed()).toBe(4)
    expect(event.payload).toMatchObject({ resolution: { baseDamage: 7, calculatedDamage: 7 } })
  })

  it('el ataque NO usa el valor de Ataque como dano: 15 de Ataque no quita 15 de Vida', async () => {
    const { useCase, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(1),
    ])

    await useCase.execute(command())

    expect(healthOf(await room(), 'B')?.current).toBe(43)
  })

  it('el turno pasa al rival y el rival puede responder: dos ataques, dos eventos, seq 2 y 3', async () => {
    const { useCase, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
      attackDie(6),
      effect(RandomEffectType.Damage),
      damageDie(2),
    ])

    const first = await useCase.execute(command())
    const second = await useCase.execute(
      command({ requesterId: 'b1', commandId: 'cmd-2', target: { teamLabel: 'A', seat: 0 } }),
    )
    const after = await room()

    expect([first.event.seq, second.event.seq]).toEqual([2, 3])
    expect(healthOf(after, 'B')?.current).toBe(40)
    expect(healthOf(after, 'A')?.current).toBe(42)
    expect(after.battle?.turnsCompleted).toBe(2)
    expect(after.battleView()?.currentTurn.playerId).toBe('a1')
    expect(after.battleView()?.round).toBe(2)
  })

  it('el ataque basico no aporta Poder al evento (sin estado de habilidades, la vista lo deja en null)', async () => {
    const { useCase, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])

    const { event } = await useCase.execute(command())

    const powerKeys = Object.keys(event.payload).filter((key) =>
      /power|cooldown|skill|bonus/i.test(key),
    )

    expect(powerKeys).toEqual([])
    expect((await room()).battleView()?.combatants.map((combatant) => combatant.power)).toEqual([
      null,
      null,
    ])
  })

  it('el objetivo elegido es el unico que cambia (2v2)', async () => {
    const { useCase, room } = await setup({ teamSizes: [2, 2] }, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])

    await useCase.execute(command({ target: { teamLabel: 'B', seat: 1 } }))
    const after = await room()

    expect(healthOf(after, 'B', 1)?.current).toBe(40)
    expect(healthOf(after, 'B', 0)?.current).toBe(44)
    expect(healthOf(after, 'A', 0)?.current).toBe(44)
    expect(healthOf(after, 'A', 1)?.current).toBe(44)
  })

  it('un jugador con Poder 0 puede atacar: el ataque no tiene puerta de Poder (CA-04)', async () => {
    // El perfil congelado ni siquiera modela Poder: no hay nada que pueda deshabilitar el ataque.
    const { useCase } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(1),
    ])

    await expect(useCase.execute(command())).resolves.toMatchObject({ replayed: false })
  })
})

describe('ExecuteBasicAttack — rechazos: 0 sorteos, nada cambia', () => {
  const rejected = async (
    options: BattleWithCombatOptions,
    input: Partial<ExecuteBasicAttackInput>,
    error: new (...args: never[]) => Error,
  ): Promise<void> => {
    // Secuencia VACIA: cualquier sorteo lanzaria "scriptedSequence agotada".
    const { useCase, sequence, room } = await setup(options, [])
    const before = JSON.stringify((await room()).toSnapshot())

    await expect(useCase.execute(command(input))).rejects.toBeInstanceOf(error)

    expect(sequence.consumed()).toBe(0)
    expect(JSON.stringify((await room()).toSnapshot())).toBe(before)
  }

  it('fuera de turno', () =>
    rejected({}, { requesterId: 'b1', target: { teamLabel: 'A', seat: 0 } }, NotYourTurnError))

  it('objetivo inexistente', () =>
    rejected({}, { target: { teamLabel: 'Z', seat: 9 } }, InvalidTargetError))

  it('objetivo propio', () =>
    rejected({}, { target: { teamLabel: 'A', seat: 0 } }, SameTeamTargetError))

  it('objetivo aliado (2v2)', () =>
    rejected({ teamSizes: [2, 2] }, { target: { teamLabel: 'A', seat: 1 } }, SameTeamTargetError))

  it('objetivo sin Vida', () => rejected({ health: { 'B#0': 0 } }, {}, TargetUnavailableError))

  it('atacante sin Vida', () => rejected({ health: { 'A#0': 0 } }, {}, ActorUnavailableError))

  it('batalla anterior a HU-18 (sin snapshot de combate)', () =>
    rejected({ withCombat: false }, {}, UnsupportedCombatProfileError))

  it('objetivo AI (sin perfil)', () =>
    rejected({ mode: 'PVE', teamSizes: [1, 1], aiInTeamB: 1 }, {}, UnsupportedCombatProfileError))

  it('sanador atacante (sin Ataque ni Dano)', () =>
    rejected(
      { profiles: { a1: combatProfileFixture({ subtype: 'MEDICO', attack: null, damage: null }) } },
      {},
      UnsupportedCombatProfileError,
    ))

  it('Dano PERCENTAGE', () =>
    rejected(
      {
        profiles: {
          a1: combatProfileFixture({ damage: { mode: 'PERCENTAGE', basisPoints: 300 } }),
        },
      },
      {},
      UnsupportedCombatProfileError,
    ))

  it('un subtipo que HU-20 no sabe preparar es un perfil no soportado (no un fallo interno)', () =>
    rejected(
      { profiles: { a1: combatProfileFixture({ subtype: 'SUBTIPO_INVENTADO' }) } },
      {},
      UnsupportedCombatProfileError,
    ))

  it('commandId invalido', () => rejected({}, { commandId: '' }, InvalidCommandIdError))

  it('jugador ajeno a la sala', () =>
    rejected({}, { requesterId: 'intruso' }, RoomAccessForbiddenError))

  it('sala inexistente', () =>
    rejected({}, { roomId: '22222222-2222-4222-8222-222222222222' }, RoomNotFoundError))

  it('sala que no esta en batalla', async () => {
    const inner = new InMemoryBattleRoomRepository()
    const { preparingRoom } = await import('../fixtures/battle')

    await inner.save(preparingRoom(), 0)

    const sequence = scriptedSequence([])
    const useCase = new ExecuteBasicAttack(inner, clock, sequence, new ChannelLock())

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(BattleNotInProgressError)
    expect(sequence.consumed()).toBe(0)
  })

  it('un rechazo NO avanza el turno: quien tenia el turno lo conserva y puede reintentar', async () => {
    const { useCase, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])

    await expect(
      useCase.execute(command({ target: { teamLabel: 'A', seat: 0 } })),
    ).rejects.toBeInstanceOf(SameTeamTargetError)
    expect((await room()).battleView()?.currentTurn.playerId).toBe('a1')

    await expect(useCase.execute(command({ commandId: 'cmd-2' }))).resolves.toMatchObject({
      replayed: false,
    })
  })
})

describe('ExecuteBasicAttack — idempotencia por commandId', () => {
  it('repetir el MISMO commandId: mismo evento, sin sorteos, sin dano, sin turno, sin guardar', async () => {
    const { useCase, sequence, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])

    const first = await useCase.execute(command())
    const consumed = sequence.consumed()
    const afterFirst = await room()
    const second = await useCase.execute(command())
    const afterSecond = await room()

    expect(second.replayed).toBe(true)
    expect(second.event).toEqual(first.event)
    expect(sequence.consumed()).toBe(consumed)
    expect(healthOf(afterSecond, 'B')?.current).toBe(40)
    expect(afterSecond.battle?.turnsCompleted).toBe(1)
    expect(afterSecond.version).toBe(afterFirst.version)
    expect(afterSecond.events).toHaveLength(2)
  })

  it('el reintento se reconoce aunque el turno ya sea del rival', async () => {
    const { useCase } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])

    await useCase.execute(command())

    await expect(useCase.execute(command())).resolves.toMatchObject({ replayed: true })
  })

  it('un commandId DISTINTO en un turno que ya no es suyo: NotYourTurnError, sin sorteos', async () => {
    const { useCase, sequence } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])

    await useCase.execute(command())
    const consumed = sequence.consumed()

    await expect(useCase.execute(command({ commandId: 'cmd-2' }))).rejects.toBeInstanceOf(
      NotYourTurnError,
    )
    expect(sequence.consumed()).toBe(consumed)
  })
})

describe('ExecuteBasicAttack — concurrencia (dos pestanas del mismo jugador)', () => {
  it('dos comandos DISTINTOS a la vez: solo UNO muta la batalla; el otro NotYourTurn sin sortear', async () => {
    const { useCase, sequence, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])

    const results = await Promise.allSettled([
      useCase.execute(command({ commandId: 'cmd-x' })),
      useCase.execute(command({ commandId: 'cmd-y' })),
    ])
    const after = await room()

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(NotYourTurnError),
    })
    // El perdedor NO consumio sorteos: solo se sortea lo del ganador.
    expect(sequence.consumed()).toBe(3)
    expect(healthOf(after, 'B')?.current).toBe(40)
    expect(after.battle?.turnsCompleted).toBe(1)
    expect(after.events).toHaveLength(2)
    expect(after.handledCommands).toHaveLength(1)
  })

  it('el MISMO commandId a la vez (doble clic): una ejecucion y una repeticion, un solo dano', async () => {
    const { useCase, sequence, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])

    const [first, second] = await Promise.all([
      useCase.execute(command()),
      useCase.execute(command()),
    ])
    const after = await room()

    expect([first.replayed, second.replayed].sort()).toEqual([false, true])
    expect(second.event).toEqual(first.event)
    expect(sequence.consumed()).toBe(3)
    expect(healthOf(after, 'B')?.current).toBe(40)
    expect(after.battle?.turnsCompleted).toBe(1)
  })

  it('salas distintas no se esperan entre si', async () => {
    const other = '33333333-3333-4333-8333-333333333333'
    const inner = new InMemoryBattleRoomRepository()

    await inner.save(battleWithCombat(), 0)
    await inner.save(battleWithCombat({ id: other }), 0)

    const sequence = scriptedSequence([
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
      attackDie(5),
      effect(RandomEffectType.Damage),
      damageDie(4),
    ])
    const useCase = new ExecuteBasicAttack(inner, clock, sequence, new ChannelLock())

    const results = await Promise.all([
      useCase.execute(command()),
      useCase.execute(command({ roomId: other })),
    ])

    expect(results.every((result) => !result.replayed)).toBe(true)
  })
})

describe('ExecuteBasicAttack — conflicto de version: NUNCA se vuelve a sortear', () => {
  const conflictOnce = (
    inner: BattleRoomRepositoryPort,
    beforeConflict: () => Promise<void> = () => Promise.resolve(),
  ): BattleRoomRepositoryPort => {
    let thrown = false

    return {
      findById: (id) => inner.findById(id),
      findWaitingForPlayers: () => inner.findWaitingForPlayers(),
      save: async (room, expectedVersion) => {
        if (!thrown) {
          thrown = true
          await beforeConflict()

          throw new RoomConflictError(room.id)
        }

        return inner.save(room, expectedVersion)
      },
    }
  }

  it('un conflicto sin comando ya procesado se propaga y NO se resuelve otra aleatoriedad', async () => {
    const { useCase, sequence, room } = await setup(
      {},
      [attackDie(5), effect(RandomEffectType.Damage), damageDie(4)],
      (repo) => conflictOnce(repo),
    )

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(RoomConflictError)

    // Los 3 sorteos del primer intento; ninguno mas: no hubo re-sorteo.
    expect(sequence.consumed()).toBe(3)
    // Y nada quedo a medias.
    const after = await room()

    expect(healthOf(after, 'B')?.current).toBe(44)
    expect(after.battle?.turnsCompleted).toBe(0)
    expect(after.handledCommands).toEqual([])
  })

  it('tras el conflicto el cliente reintenta con el MISMO commandId y la accion se ejecuta una sola vez', async () => {
    const { useCase, room } = await setup(
      {},
      [
        attackDie(5),
        effect(RandomEffectType.Damage),
        damageDie(4),
        attackDie(6),
        effect(RandomEffectType.Damage),
        damageDie(2),
      ],
      (repo) => conflictOnce(repo),
    )

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(RoomConflictError)
    const retry = await useCase.execute(command())

    expect(retry.replayed).toBe(false)
    expect((await room()).handledCommands).toEqual([{ commandId: 'cmd-1', seq: 2 }])
    expect(healthOf(await room(), 'B')?.current).toBe(42)
  })

  it('si el conflicto lo causo OTRO escritor que ya proceso ese commandId, se devuelve SU resultado (sin re-sorteo, sin segundo dano)', async () => {
    const shared = new InMemoryBattleRoomRepository()

    await shared.save(battleWithCombat(), 0)

    // Un escritor concurrente aplica el mismo comando justo antes de que guardemos.
    const competing = new ExecuteBasicAttack(
      shared,
      clock,
      scriptedSequence([attackDie(6), effect(RandomEffectType.Damage), damageDie(3)]),
      new ChannelLock(),
    )
    const mine = scriptedSequence([attackDie(5), effect(RandomEffectType.Damage), damageDie(4)])
    const useCase = new ExecuteBasicAttack(
      conflictOnce(shared, async () => {
        await competing.execute(command())
      }),
      clock,
      mine,
      new ChannelLock(),
    )

    const result = await useCase.execute(command())
    const after = await shared.findById(ROOM_ID)

    expect(result.replayed).toBe(true)
    // El resultado es el del escritor que gano (dano 3), no el que yo habia sorteado (4).
    expect(result.event.payload).toMatchObject({ resolution: { baseDamage: 3 } })
    expect(healthOf(after as never, 'B')?.current).toBe(41)
    expect(after?.events).toHaveLength(2)
    expect(mine.consumed()).toBe(3)
  })
})

describe('ExecuteBasicAttack — semilla y fuentes de aleatoriedad', () => {
  it('usa SOLO la secuencia inyectada (RandomSequencePort): sin ella no puede sortear', async () => {
    const inner = new InMemoryBattleRoomRepository()

    await inner.save(battleWithCombat(), 0)

    const nextIndex = jest.fn((): never => {
      throw new Error('sin sorteos')
    })
    const spy: RandomSequencePort = { nextIndex }
    const useCase = new ExecuteBasicAttack(inner, clock, spy, new ChannelLock())

    await expect(useCase.execute(command())).rejects.toThrow('sin sorteos')
    expect(nextIndex).toHaveBeenCalledTimes(1)
  })
})
