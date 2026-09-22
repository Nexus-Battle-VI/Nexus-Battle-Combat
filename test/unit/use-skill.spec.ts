import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../src/application/errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import { UseSkill, type UseSkillInput } from '../../src/application/use-cases/UseSkill'
import { BattleEventType } from '../../src/domain/entities/BattleEvent'
import {
  InvalidTargetError,
  NotYourTurnError,
  SameTeamTargetError,
  SkillOnCooldownError,
  SkillsNotAvailableError,
  UnknownSkillError,
  UnsupportedSkillEffectError,
} from '../../src/domain/errors/BattleErrors'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { ROOM_ID, clock, scriptedSequence } from '../fixtures/battle'
import {
  battleWithCombat,
  healthOf,
  indexForEffect,
  indexForFace,
  type BattleWithCombatOptions,
} from '../fixtures/basic-attack'
import {
  EMBATE,
  EMBATE_ID,
  LOTUS_ID,
  SHIELD_STRIKE,
  SHIELD_STRIKE_ID,
  STONE_HAND_ID,
  STORM_ID,
  battleWithSkills,
  skillProfile,
} from '../fixtures/skills'

/**
 * `UseSkill` de extremo a extremo en la capa de aplicacion (HU-19), con la secuencia HU-24
 * GUIONIZADA: cada sorteo se conoce, se cuenta y su ORDEN se comprueba con caras distintas.
 *
 * Perfil por defecto: Guerrero Armas de la Tabla 6 (Vida 44, Ataque 10 + 1d6, Defensa 11,
 * Dano 1d6) con 10 de Poder y cinco habilidades. Contra Defensa 11, una cara 1 sin bono iguala
 * (10 + 1 = 11, NO supera).
 */
const ARMAS = 'GUERRERO_ARMAS'
const TARGET = { teamLabel: 'B', seat: 0 } as const

const attackDie = (face: number): number => indexForFace(face, 6)
const heroDamageDie = (face: number): number => indexForFace(face, 6)
const die = (face: number, sides: number): number => indexForFace(face, sides)
const effect = (kind: RandomEffectType, percent?: number): number =>
  indexForEffect(ARMAS, kind, percent)

const command = (overrides: Partial<UseSkillInput> = {}): UseSkillInput => ({
  roomId: ROOM_ID,
  requesterId: 'a1',
  commandId: 'cmd-1',
  abilityId: SHIELD_STRIKE_ID,
  target: TARGET,
  ...overrides,
})

const setup = async (
  options: BattleWithCombatOptions = {},
  indices: readonly number[] = [],
  wrap: (repo: BattleRoomRepositoryPort) => BattleRoomRepositoryPort = (repo) => repo,
  build = battleWithSkills,
) => {
  const inner = new InMemoryBattleRoomRepository()

  await inner.save(build(options), 0)

  const sequence = scriptedSequence(indices)
  let saves = 0
  const counting: BattleRoomRepositoryPort = {
    findById: (id) => inner.findById(id),
    findWaitingForPlayers: () => inner.findWaitingForPlayers(),
    findInBattle: () => inner.findInBattle(),
    findFinishedSince: (since) => inner.findFinishedSince(since),
    findCancelledSince: (since) => inner.findCancelledSince(since),
    save: (room, expectedVersion) => {
      saves += 1

      return inner.save(room, expectedVersion)
    },
  }
  const repo = wrap(counting)
  const lock = new ChannelLock()
  const basicAttack = new ExecuteBasicAttack(repo, clock, sequence, lock)
  const useCase = new UseSkill(repo, clock, sequence, lock, basicAttack)
  const room = async () => {
    const found = await inner.findById(ROOM_ID)

    if (found === null) {
      throw new Error('la sala desaparecio')
    }

    return found
  }

  return { inner, useCase, basicAttack, sequence, room, saves: () => saves }
}

const viewOf = async (
  room: () => ReturnType<typeof battleWithSkills> | Promise<ReturnType<typeof battleWithSkills>>,
  label: string,
) => {
  const found = (await room()).battleView()?.combatants.find((c) => c.teamLabel === label)

  if (found === undefined) {
    throw new Error('sin combatiente')
  }

  return found
}

describe('UseSkill — flujo principal (CA-01, CA-05, CA-09)', () => {
  it('habilidad -> resolucion -> Vida, Poder y recarga -> fin de turno, en UNA ejecucion y UNA escritura', async () => {
    // Golpe con escudo (+2 al Ataque): dado de Ataque 5 -> 10 + 2 + 5 = 17 > 11; dano; dado de Dano 4.
    const { useCase, sequence, room, saves } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(4),
    ])

    const result = await useCase.execute(command())

    expect(result.replayed).toBe(false)
    expect(result.event).toMatchObject({ seq: 2, type: BattleEventType.SkillUsed })
    expect(result.event.payload).toMatchObject({
      commandId: 'cmd-1',
      actor: { teamLabel: 'A', seat: 0 },
      target: { teamLabel: 'B', seat: 0 },
      skill: { abilityId: SHIELD_STRIKE_ID, name: 'Golpe con escudo' },
      power: { before: 10, after: 8 },
      cooldown: { remainingTurns: 1 },
      bonus: { attack: 2, damage: 0 },
      resolution: {
        attackValue: 17,
        defenseValue: 11,
        effective: true,
        baseDamage: 4,
        appliedDamage: 4,
      },
      targetHealth: { before: 44, after: 40 },
    })
    expect(sequence.consumed()).toBe(3)
    expect(saves()).toBe(1)
    expect(healthOf(await room(), 'B')?.current).toBe(40)
    expect((await viewOf(room, 'A')).power).toEqual({ current: 8, max: 10 })
    expect((await viewOf(room, 'A')).skills[0]).toMatchObject({
      cooldownRemaining: 1,
      status: 'RECHARGING',
    })
    expect((await room()).battle?.turnsCompleted).toBe(1)
  })

  it('el bono de Ataque convierte un fallo en golpe: cara 1 con la habilidad supera (13) y sin ella iguala (11)', async () => {
    const skill = await setup({}, [attackDie(1), effect(RandomEffectType.Damage), heroDamageDie(3)])
    const basic = await setup({}, [attackDie(1)], (repo) => repo, battleWithCombat)

    const withSkill = await skill.useCase.execute(command())
    const withoutSkill = await basic.basicAttack.execute({
      roomId: ROOM_ID,
      requesterId: 'a1',
      commandId: 'cmd-1',
      target: TARGET,
    })

    expect(withSkill.event.payload).toMatchObject({
      resolution: { attackValue: 13, effective: true },
    })
    expect(withoutSkill.event.payload).toMatchObject({
      resolution: { attackValue: 11, effective: false },
    })
  })

  it('la igualdad NO supera: el bono deja el Ataque exactamente en la Defensa y el golpe no es efectivo', async () => {
    // Defensa 12: 10 + 2 (bono) + 0 no es posible; se usa una Defensa que iguale con cara 1:
    // 10 + 2 + 1 = 13 contra Defensa 13.
    const { useCase } = await setup(
      { profiles: { a1: skillProfile(), b1: skillProfile({ defense: 13 }) } },
      [attackDie(1)],
    )

    const result = await useCase.execute(command())

    expect(result.event.payload).toMatchObject({
      resolution: { attackValue: 13, defenseValue: 13, effective: false },
      bonus: { attack: 2, damage: null },
    })
  })

  it('Golpe de tormenta: los dados del bono de Ataque se tiran ANTES del dado de Ataque, en este orden exacto', async () => {
    // bono 3d6 -> caras 2, 3, 4 (=9); dado de Ataque 5; efecto; dado de Dano del heroe 3; +2 fijo al Dano.
    // Ataque = 10 + 9 + 5 = 24. Dano base = 3 + 2 = 5. Si el orden fuera otro, las cifras cambiarian.
    const { useCase, sequence, room } = await setup({}, [
      die(2, 6),
      die(3, 6),
      die(4, 6),
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(3),
    ])

    const result = await useCase.execute(command({ abilityId: STORM_ID }))

    expect(result.event.payload).toMatchObject({
      power: { before: 10, after: 4 },
      bonus: { attack: 9, damage: 2 },
      resolution: { attackValue: 24, effective: true, baseDamage: 5, appliedDamage: 5 },
      targetHealth: { before: 44, after: 39 },
    })
    expect(sequence.consumed()).toBe(6)
    expect(healthOf(await room(), 'B')?.current).toBe(39)
  })

  it('Flor de loto: el dado de Dano del heroe va ANTES que los dados del bono de Dano (5. despues de 4.)', async () => {
    // Ataque 10 + 5 = 15; efecto; dado de Dano del heroe 4; bono 4d8 -> 1, 2, 3, 4 (=10). Base = 4 + 10.
    const { useCase, sequence } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(4),
      die(1, 8),
      die(2, 8),
      die(3, 8),
      die(4, 8),
    ])

    const result = await useCase.execute(command({ abilityId: LOTUS_ID }))

    expect(result.event.payload).toMatchObject({
      bonus: { attack: 0, damage: 10 },
      resolution: { attackValue: 15, baseDamage: 14, calculatedDamage: 14, appliedDamage: 14 },
      targetHealth: { before: 44, after: 30 },
    })
    expect(sequence.consumed()).toBe(7)
  })

  it('un golpe NO efectivo con bono en dados solo consume el bono y el dado de Ataque; el Poder se gasta igual', async () => {
    // Defensa 40: 10 + 3 (1+1+1) + 1 = 14, no supera. No hay efecto, dado de Dano ni bono de Dano.
    const { useCase, sequence, room } = await setup(
      { profiles: { a1: skillProfile(), b1: skillProfile({ defense: 40 }) } },
      [die(1, 6), die(1, 6), die(1, 6), attackDie(1)],
    )

    const result = await useCase.execute(command({ abilityId: STORM_ID }))

    expect(result.event.payload).toMatchObject({
      power: { before: 10, after: 4 },
      cooldown: { remainingTurns: 1 },
      bonus: { attack: 3, damage: null },
      resolution: {
        attackValue: 14,
        effective: false,
        effect: null,
        percent: null,
        baseDamage: null,
      },
      targetHealth: { before: 44, after: 44 },
    })
    expect(sequence.consumed()).toBe(4)
    expect((await viewOf(room, 'A')).power?.current).toBe(4)
    expect((await room()).battle?.turnsCompleted).toBe(1)
  })

  it('un efecto del 0 % no sortea el dado de Dano ni los dados del bono: no se consume aleatoriedad que no puede afectar', async () => {
    const { useCase, sequence, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.NoDamage),
    ])

    const result = await useCase.execute(command({ abilityId: LOTUS_ID }))

    expect(result.event.payload).toMatchObject({
      bonus: { attack: 0, damage: null },
      resolution: { effect: 'NO_DAMAGE', percent: 0, baseDamage: null, calculatedDamage: 0 },
      power: { before: 10, after: 8 },
    })
    expect(sequence.consumed()).toBe(2)
    expect(healthOf(await room(), 'B')?.current).toBe(44)
  })

  it('el porcentaje del efecto actua sobre el dano base YA con el bono: floor((5 + 1) x 137 / 100) = 8', async () => {
    // Embate sangriento: +2 al Ataque y +1 al Dano. Dado de Dano del heroe 5; critico 137 %.
    const { useCase, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.CriticalDamage, 137),
      heroDamageDie(5),
    ])

    const result = await useCase.execute(command({ abilityId: EMBATE_ID }))

    expect(result.event.payload).toMatchObject({
      bonus: { attack: 2, damage: 1 },
      resolution: {
        effect: 'CRITICAL_DAMAGE',
        percent: 137,
        baseDamage: 6,
        calculatedDamage: 8,
        appliedDamage: 8,
      },
      targetHealth: { before: 44, after: 36 },
    })
    expect(healthOf(await room(), 'B')?.current).toBe(36)
  })

  it('un Dano FIXED del heroe no sortea: solo el efecto', async () => {
    const { useCase, sequence } = await setup(
      {
        profiles: {
          a1: skillProfile({ damage: { mode: 'FIXED', amount: 4 } }),
          b1: skillProfile(),
        },
      },
      [attackDie(5), effect(RandomEffectType.Damage)],
    )

    const result = await useCase.execute(command())

    expect(result.event.payload).toMatchObject({ resolution: { baseDamage: 4, appliedDamage: 4 } })
    expect(sequence.consumed()).toBe(2)
  })

  it('el dano no baja la Vida de 0 (overkill)', async () => {
    const { useCase, room } = await setup({ health: { 'B#0': 2 } }, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(6),
    ])

    const result = await useCase.execute(command())

    expect(result.event.payload).toMatchObject({
      resolution: { calculatedDamage: 6, appliedDamage: 2 },
      targetHealth: { before: 2, after: 0 },
    })
    expect(healthOf(await room(), 'B')?.current).toBe(0)
  })
})

describe('UseSkill — Poder insuficiente: se degrada a ataque basico (HU-11)', () => {
  const lowPower = { profiles: { a1: skillProfile({ maxPower: 1 }), b1: skillProfile() } }

  it('el evento es un ataque basico con degradedFrom; NO se aplica el bono; Poder y recarga intactos; el turno avanza', async () => {
    // Ataque basico: 10 + 5 = 15 (SIN el +2 de la habilidad); dano; dado de Dano 4.
    const { useCase, sequence, room, saves } = await setup(lowPower, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(4),
    ])

    const result = await useCase.execute(command())

    expect(result.replayed).toBe(false)
    expect(result.event.type).toBe(BattleEventType.BasicAttackResolved)
    expect(result.event.payload).toMatchObject({
      degradedFrom: {
        command: 'useSkill',
        abilityId: SHIELD_STRIKE_ID,
        reason: 'INSUFFICIENT_POWER',
      },
      resolution: { attackValue: 15, effective: true, baseDamage: 4 },
      targetHealth: { before: 44, after: 40 },
    })
    expect(sequence.consumed()).toBe(3)
    expect(saves()).toBe(1)
    expect((await viewOf(room, 'A')).power?.current).toBe(1)
    expect((await viewOf(room, 'A')).skills[0]).toMatchObject({
      cooldownRemaining: 0,
      status: 'READY',
    })
    expect((await room()).battle?.turnsCompleted).toBe(1)
  })

  it('un punto menos que el costo degrada; con el costo exacto NO', async () => {
    const exact = await setup(
      { profiles: { a1: skillProfile({ maxPower: 2 }), b1: skillProfile() } },
      [attackDie(5), effect(RandomEffectType.Damage), heroDamageDie(4)],
    )

    const result = await exact.useCase.execute(command())

    expect(result.event.type).toBe(BattleEventType.SkillUsed)
    expect((await viewOf(exact.room, 'A')).power?.current).toBe(0)
  })

  it('un ataque basico que HU-18 rechazaria se rechaza igual: nada cambia y no se sortea', async () => {
    const { useCase, sequence, room } = await setup(
      {
        profiles: {
          a1: skillProfile({ maxPower: 1, attack: null, damage: null }),
          b1: skillProfile(),
        },
      },
      [],
    )

    await expect(useCase.execute(command())).rejects.toMatchObject({
      code: 'UNSUPPORTED_COMBAT_PROFILE',
    })

    expect(sequence.consumed()).toBe(0)
    expect((await room()).battle?.turnsCompleted).toBe(0)
  })

  it('el mismo commandId reintentado devuelve el ataque basico ya guardado (sin sorteos ni segundo dano)', async () => {
    const { useCase, sequence, room } = await setup(lowPower, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(4),
    ])

    const first = await useCase.execute(command())
    const retry = await useCase.execute(command())

    expect(retry.replayed).toBe(true)
    expect(retry.event).toBe((await room()).events.at(-1))
    expect(retry.event.seq).toBe(first.event.seq)
    expect(sequence.consumed()).toBe(3)
    expect(healthOf(await room(), 'B')?.current).toBe(40)
  })
})

describe('UseSkill — rechazos: 0 sorteos y nada cambia', () => {
  it.each([
    [
      'fuera de turno',
      { requesterId: 'b1', target: { teamLabel: 'A', seat: 0 } },
      NotYourTurnError,
    ],
    [
      'una habilidad que el heroe no tiene',
      { abilityId: '99999999-9999-4999-8999-999999999999' },
      UnknownSkillError,
    ],
    ['un efecto no soportado', { abilityId: STONE_HAND_ID }, UnsupportedSkillEffectError],
    ['un objetivo inexistente', { target: { teamLabel: 'Z', seat: 0 } }, InvalidTargetError],
    ['un objetivo del propio equipo', { target: { teamLabel: 'A', seat: 0 } }, SameTeamTargetError],
  ])('%s', async (_label, patch, errorClass) => {
    const { useCase, sequence, room, saves } = await setup({}, [])
    const before = JSON.stringify((await room()).toSnapshot())

    await expect(useCase.execute(command(patch as Partial<UseSkillInput>))).rejects.toBeInstanceOf(
      errorClass,
    )

    expect(sequence.consumed()).toBe(0)
    expect(saves()).toBe(0)
    expect(JSON.stringify((await room()).toSnapshot())).toBe(before)
  })

  it('un objetivo aliado en 3v3 (HU-12, Issue #21): el mas lejano en la cola tambien se rechaza', async () => {
    const { useCase, sequence, room, saves } = await setup({ teamSizes: [3, 3] }, [])
    const before = JSON.stringify((await room()).toSnapshot())

    await expect(
      useCase.execute(command({ target: { teamLabel: 'A', seat: 2 } })),
    ).rejects.toBeInstanceOf(SameTeamTargetError)

    expect(sequence.consumed()).toBe(0)
    expect(saves()).toBe(0)
    expect(JSON.stringify((await room()).toSnapshot())).toBe(before)
  })

  it('la sala no existe / quien envia no es participante', async () => {
    const { useCase } = await setup({}, [])

    await expect(
      useCase.execute(command({ roomId: '22222222-2222-4222-8222-222222222222' })),
    ).rejects.toBeInstanceOf(RoomNotFoundError)
    await expect(useCase.execute(command({ requesterId: 'intruso' }))).rejects.toBeInstanceOf(
      RoomAccessForbiddenError,
    )
  })

  it('una batalla iniciada antes de HU-19: SkillsNotAvailableError, y el ataque basico sigue funcionando', async () => {
    const { useCase, basicAttack, sequence } = await setup(
      {},
      [attackDie(5), effect(RandomEffectType.Damage), heroDamageDie(4)],
      (repo) => repo,
      battleWithCombat,
    )

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(SkillsNotAvailableError)
    expect(sequence.consumed()).toBe(0)

    const attack = await basicAttack.execute({
      roomId: ROOM_ID,
      requesterId: 'a1',
      commandId: 'cmd-2',
      target: TARGET,
    })

    expect(attack.event.type).toBe(BattleEventType.BasicAttackResolved)
  })

  it('CA-04/CA-07: usar la misma habilidad en el turno propio siguiente es SkillOnCooldownError sin sorteos', async () => {
    const { useCase, basicAttack, sequence, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(4),
      // turno de b1 (ataque basico)
      attackDie(4),
      effect(RandomEffectType.Damage),
      heroDamageDie(3),
    ])

    await useCase.execute(command())
    await basicAttack.execute({
      roomId: ROOM_ID,
      requesterId: 'b1',
      commandId: 'b-1',
      target: { teamLabel: 'A', seat: 0 },
    })
    const drawn = sequence.consumed()

    await expect(useCase.execute(command({ commandId: 'cmd-2' }))).rejects.toBeInstanceOf(
      SkillOnCooldownError,
    )

    expect(sequence.consumed()).toBe(drawn)
    expect((await room()).handledCommands.map((handled) => handled.commandId)).toEqual([
      'cmd-1',
      'b-1',
    ])
  })
})

describe('UseSkill — idempotencia por commandId (contrato §8)', () => {
  it('repetir el commandId devuelve el mismo evento: sin sorteos, sin segundo cobro de Poder, sin segunda recarga, sin segundo turno', async () => {
    const { useCase, sequence, room, saves } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(4),
    ])

    const first = await useCase.execute(command())
    const retry = await useCase.execute(command())

    expect(retry.replayed).toBe(true)
    expect(retry.event).toBe((await room()).events.at(-1))
    expect(retry.event.seq).toBe(first.event.seq)
    expect(sequence.consumed()).toBe(3)
    expect(saves()).toBe(1)
    expect((await viewOf(room, 'A')).power?.current).toBe(8)
    expect((await room()).battle?.turnsCompleted).toBe(1)
    expect((await room()).handledCommands).toEqual([{ commandId: 'cmd-1', seq: 2 }])
  })

  it('el commandId es comun a attack y useSkill: el de una habilidad reintentado como otra habilidad devuelve lo guardado', async () => {
    const { useCase, sequence } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(4),
    ])

    const first = await useCase.execute(command())
    const retry = await useCase.execute(command({ abilityId: EMBATE_ID }))

    expect(retry.replayed).toBe(true)
    expect(retry.event.seq).toBe(first.event.seq)
    expect(sequence.consumed()).toBe(3)
  })

  it('dos comandos DISTINTOS del mismo jugador en el mismo turno: solo uno muta; el otro es NOT_YOUR_TURN sin sorteos ni doble cobro', async () => {
    const { useCase, sequence, room } = await setup({}, [
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(4),
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(4),
    ])

    const results = await Promise.allSettled([
      useCase.execute(command({ commandId: 'cmd-1' })),
      useCase.execute(command({ commandId: 'cmd-2', abilityId: EMBATE_ID })),
    ])

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(NotYourTurnError)
    expect(sequence.consumed()).toBe(3)
    expect((await viewOf(room, 'A')).power?.current).toBe(8)
    expect((await room()).battle?.turnsCompleted).toBe(1)
  })
})

describe('UseSkill — conflicto de version: NUNCA se vuelve a sortear', () => {
  const conflictOnce = (inner: BattleRoomRepositoryPort): BattleRoomRepositoryPort => {
    let thrown = false

    return {
      findById: (id) => inner.findById(id),
      findWaitingForPlayers: () => inner.findWaitingForPlayers(),
      findInBattle: () => inner.findInBattle(),
      findFinishedSince: (since) => inner.findFinishedSince(since),
      findCancelledSince: (since) => inner.findCancelledSince(since),
      save: (room, expectedVersion) => {
        if (!thrown) {
          thrown = true

          return Promise.reject(new RoomConflictError(room.id))
        }

        return inner.save(room, expectedVersion)
      },
    }
  }

  it('un conflicto se propaga, no se re-sortea y nada queda a medias (Poder, recarga y turno intactos)', async () => {
    const { useCase, sequence, room } = await setup(
      {},
      [attackDie(5), effect(RandomEffectType.Damage), heroDamageDie(4)],
      conflictOnce,
    )

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(RoomConflictError)

    expect(sequence.consumed()).toBe(3)
    expect((await viewOf(room, 'A')).power?.current).toBe(10)
    expect((await viewOf(room, 'A')).skills[0]?.cooldownRemaining).toBe(0)
    expect((await room()).battle?.turnsCompleted).toBe(0)
    expect((await room()).handledCommands).toEqual([])
  })

  it('tras el conflicto el cliente reintenta con el MISMO commandId y la habilidad se ejecuta una sola vez', async () => {
    const { useCase, room } = await setup(
      {},
      [
        attackDie(5),
        effect(RandomEffectType.Damage),
        heroDamageDie(4),
        attackDie(6),
        effect(RandomEffectType.Damage),
        heroDamageDie(2),
      ],
      conflictOnce,
    )

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(RoomConflictError)
    const retry = await useCase.execute(command())

    expect(retry.replayed).toBe(false)
    expect((await room()).handledCommands).toEqual([{ commandId: 'cmd-1', seq: 2 }])
    expect((await viewOf(room, 'A')).power?.current).toBe(8)
  })
})

describe('UseSkill — el turno siguiente (regeneracion y recarga a traves del caso de uso)', () => {
  it('a1 usa una habilidad de 6, b1 ataca y a1 regenera +2 al abrirse su turno; la recarga sigue hasta cerrarse', async () => {
    const { useCase, basicAttack, room } = await setup({}, [
      // a1: Golpe de tormenta (6 de Poder). Bono 3d6 (1,1,1), Ataque 5, efecto, dado de Dano 3.
      die(1, 6),
      die(1, 6),
      die(1, 6),
      attackDie(5),
      effect(RandomEffectType.Damage),
      heroDamageDie(3),
      // b1: ataque basico.
      attackDie(4),
      effect(RandomEffectType.Damage),
      heroDamageDie(2),
    ])

    await useCase.execute(command({ abilityId: STORM_ID }))
    await basicAttack.execute({
      roomId: ROOM_ID,
      requesterId: 'b1',
      commandId: 'b-1',
      target: { teamLabel: 'A', seat: 0 },
    })

    // 10 - 6 = 4; al abrirse el turno de a1: 4 + 2 = 6. La habilidad sigue bloqueada este turno.
    expect((await viewOf(room, 'A')).power).toEqual({ current: 6, max: 10 })
    expect(
      (await viewOf(room, 'A')).skills.find((skill) => skill.abilityId === STORM_ID),
    ).toMatchObject({
      cooldownRemaining: 1,
      status: 'RECHARGING',
    })
    // Y el Poder de b1, que solo ataco, no cambio.
    expect((await viewOf(room, 'B')).power?.current).toBe(10)
  })

  it('una habilidad con dos turnos de recarga (Embate con chargeTurns 2) bloquea dos turnos propios', async () => {
    const slow = { ...EMBATE, chargeTurns: 2 }
    const { useCase, room } = await setup(
      { profiles: { a1: skillProfile({ abilities: [SHIELD_STRIKE, slow] }), b1: skillProfile() } },
      [attackDie(5), effect(RandomEffectType.Damage), heroDamageDie(4)],
    )

    await useCase.execute(command({ abilityId: EMBATE_ID }))

    expect(
      (await viewOf(room, 'A')).skills.find((skill) => skill.abilityId === EMBATE_ID)
        ?.cooldownRemaining,
    ).toBe(2)
  })
})
