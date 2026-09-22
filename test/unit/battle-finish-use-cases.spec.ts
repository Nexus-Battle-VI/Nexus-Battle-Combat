import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import { StartBattle } from '../../src/application/use-cases/StartBattle'
import { UseSkill } from '../../src/application/use-cases/UseSkill'
import { BattleEventType } from '../../src/domain/entities/BattleEvent'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import type { CombatantKey } from '../../src/domain/entities/Combatant'
import { BattleNotInProgressError, NotYourTurnError } from '../../src/domain/errors/BattleErrors'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import {
  NOW,
  ROOM_ID,
  clock,
  heroesPort,
  preparingRoom,
  scriptedRandom,
  scriptedSequence,
} from '../fixtures/battle'
import { battleWithCombat, indexForEffect, indexForFace } from '../fixtures/basic-attack'
import { finalizationHarness, mutableClock } from '../fixtures/finalization'
import { battleWithSkills, SHIELD_STRIKE_ID } from '../fixtures/skills'

const ARMAS = 'GUERRERO_ARMAS'
const TARGET: CombatantKey = { teamLabel: 'B', seat: 0 }

const attackDie = (face: number): number => indexForFace(face, 6)
const damageDie = (face: number): number => indexForFace(face, 6)
const effect = (kind: RandomEffectType, percent?: number): number =>
  indexForEffect(ARMAS, kind, percent)

/** Cambia el Poder actual de un combatiente persistido (para forzar la degradacion). */
const withPower = (room: BattleRoom, key: CombatantKey, power: number): BattleRoom => {
  const snapshot = room.toSnapshot()
  const battle = snapshot.battle
  const combatants = battle?.combatants

  if (battle === null || combatants === null || combatants === undefined) {
    throw new Error('La sala de prueba necesita snapshot de combate.')
  }

  return BattleRoom.restore({
    ...snapshot,
    battle: {
      ...battle,
      combatants: combatants.map((combatant) =>
        combatant.teamLabel === key.teamLabel && combatant.seat === key.seat
          ? { ...combatant, currentPower: power }
          : combatant,
      ),
    },
  })
}

/**
 * Casos de uso frente a la finalizacion (HU-21): liquidacion perezosa antes de
 * validar, `followUp` con `battleFinished` en la misma escritura, `finished`
 * cuando corresponde y siembra de presencia al iniciar.
 */
describe('ExecuteBasicAttack — finalizacion y liquidacion perezosa (HU-21)', () => {
  it('un golpe letal devuelve la accion con `followUp` y la sala `finished`, en UNA escritura', async () => {
    const clock = mutableClock(NOW)
    const h = finalizationHarness([], clock)
    const saved = await h.rooms.save(battleWithCombat({ health: { 'B#0': 4 } }), 0)

    let saves = 0
    const inner = h.rooms.save.bind(h.rooms)

    h.rooms.save = async (next, version) => {
      saves += 1

      return inner(next, version)
    }

    const sequence = scriptedSequence([attackDie(5), effect(RandomEffectType.Damage), damageDie(6)])
    const useCase = new ExecuteBasicAttack(h.rooms, clock, sequence, new ChannelLock(), h.settler)

    const result = await useCase.execute({
      roomId: saved.id,
      requesterId: 'a1',
      commandId: 'cmd-letal',
      target: TARGET,
    })

    expect(result.event.type).toBe(BattleEventType.BasicAttackResolved)
    expect(result.followUp.map((event) => event.type)).toEqual([BattleEventType.BattleFinished])
    expect(result.finished?.status).toBe('FINISHED')
    expect(result.finished?.result?.reason).toBe('ELIMINATION')
    expect(saves).toBe(1)
  })

  it('un comando tras el vencimiento del turno responde NOT_YOUR_TURN sin consumir un solo sorteo', async () => {
    const clock = mutableClock(NOW)
    const h = finalizationHarness([], clock)
    const saved = await h.rooms.save(battleWithCombat(), 0)
    const sequence = scriptedSequence([])
    const useCase = new ExecuteBasicAttack(h.rooms, clock, sequence, new ChannelLock(), h.settler)

    clock.advance(30_000)

    await expect(
      useCase.execute({
        roomId: saved.id,
        requesterId: 'a1',
        commandId: 'cmd-tarde',
        target: TARGET,
      }),
    ).rejects.toBeInstanceOf(NotYourTurnError)

    expect(sequence.consumed()).toBe(0)
    const after = await h.rooms.findById(saved.id)

    expect(after?.events.at(-1)?.type).toBe(BattleEventType.TurnTimedOut)
    expect(after?.battle?.currentEntry.playerId).toBe('b1')
  })

  it('tras el final responde BATTLE_NOT_ACTIVE sin sorteos ni cambios', async () => {
    const clock = mutableClock(NOW)
    const h = finalizationHarness([], clock)
    const saved = await h.rooms.save(battleWithCombat(), 0)
    const finished = saved.finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, NOW)

    await h.rooms.save(finished, saved.version)

    const sequence = scriptedSequence([])
    const useCase = new ExecuteBasicAttack(h.rooms, clock, sequence, new ChannelLock(), h.settler)

    await expect(
      useCase.execute({
        roomId: saved.id,
        requesterId: 'a1',
        commandId: 'cmd-final',
        target: TARGET,
      }),
    ).rejects.toBeInstanceOf(BattleNotInProgressError)

    expect(sequence.consumed()).toBe(0)
  })

  it('un reintento idempotente NO liquida vencimientos: devuelve su evento aunque el turno haya vencido', async () => {
    const clock = mutableClock(NOW)
    const h = finalizationHarness([], clock)
    const saved = await h.rooms.save(battleWithCombat(), 0)
    const sequence = scriptedSequence([attackDie(5), effect(RandomEffectType.Damage), damageDie(3)])
    const useCase = new ExecuteBasicAttack(h.rooms, clock, sequence, new ChannelLock(), h.settler)

    await useCase.execute({
      roomId: saved.id,
      requesterId: 'a1',
      commandId: 'cmd-unico',
      target: TARGET,
    })
    const afterFirst = await h.rooms.findById(saved.id)

    clock.advance(30_000)

    const replay = await useCase.execute({
      roomId: saved.id,
      requesterId: 'a1',
      commandId: 'cmd-unico',
      target: TARGET,
    })
    const afterReplay = await h.rooms.findById(saved.id)

    expect(replay.replayed).toBe(true)
    expect(replay.followUp).toEqual([])
    expect(replay.finished).toBeNull()
    expect(afterReplay?.lastSeq).toBe(afterFirst?.lastSeq)
    expect(afterReplay?.events.map((event) => event.type)).not.toContain(
      BattleEventType.TurnTimedOut,
    )
  })
})

describe('UseSkill — finalizacion y degradacion (HU-21)', () => {
  const skillHarness = () => {
    const clock = mutableClock(NOW)
    const h = finalizationHarness([], clock)
    const attack = new ExecuteBasicAttack(
      h.rooms,
      clock,
      scriptedSequence([]),
      new ChannelLock(),
      h.settler,
    )

    return { h, attack }
  }

  it('una habilidad letal devuelve `followUp` y la sala `finished`', async () => {
    const clock = mutableClock(NOW)
    const h = finalizationHarness([], clock)
    const saved = await h.rooms.save(battleWithSkills({ health: { 'B#0': 5 } }), 0)
    const attack = new ExecuteBasicAttack(
      h.rooms,
      clock,
      scriptedSequence([]),
      new ChannelLock(),
      h.settler,
    )
    const sequence = scriptedSequence([attackDie(5), effect(RandomEffectType.Damage), damageDie(6)])
    const useCase = new UseSkill(h.rooms, clock, sequence, new ChannelLock(), attack, h.settler)

    const result = await useCase.execute({
      roomId: saved.id,
      requesterId: 'a1',
      commandId: 'cmd-habilidad-letal',
      abilityId: SHIELD_STRIKE_ID,
      target: TARGET,
    })

    expect(result.event.type).toBe(BattleEventType.SkillUsed)
    expect(result.followUp.map((event) => event.type)).toEqual([BattleEventType.BattleFinished])
    expect(result.finished?.result?.winnerTeamLabel).toBe('A')
  })

  it('una habilidad degradada por Poder insuficiente propaga `followUp` y `finished` del ataque basico', async () => {
    const clock = mutableClock(NOW)
    const h = finalizationHarness([], clock)
    const withSkills = battleWithSkills({ health: { 'B#0': 4 } })
    const saved = await h.rooms.save(withPower(withSkills, { teamLabel: 'A', seat: 0 }, 0), 0)
    const sequence = scriptedSequence([attackDie(5), effect(RandomEffectType.Damage), damageDie(6)])
    const attack = new ExecuteBasicAttack(h.rooms, clock, sequence, new ChannelLock(), h.settler)
    const useCase = new UseSkill(h.rooms, clock, sequence, new ChannelLock(), attack, h.settler)

    const result = await useCase.execute({
      roomId: saved.id,
      requesterId: 'a1',
      commandId: 'cmd-degradada',
      abilityId: SHIELD_STRIKE_ID,
      target: TARGET,
    })

    expect(result.event.type).toBe(BattleEventType.BasicAttackResolved)
    expect(result.event.payload).toMatchObject({
      degradedFrom: { reason: 'INSUFFICIENT_POWER' },
    })
    expect(result.followUp.map((event) => event.type)).toEqual([BattleEventType.BattleFinished])
    expect(result.finished?.status).toBe('FINISHED')
  })

  it('la habilidad normal NO finaliza: `followUp` vacio y `finished` nulo', async () => {
    const { h, attack } = skillHarness()
    const saved = await h.rooms.save(battleWithSkills(), 0)
    const sequence = scriptedSequence([attackDie(5), effect(RandomEffectType.Damage), damageDie(3)])
    const useCase = new UseSkill(h.rooms, clock, sequence, new ChannelLock(), attack, h.settler)

    const result = await useCase.execute({
      roomId: saved.id,
      requesterId: 'a1',
      commandId: 'cmd-normal',
      abilityId: SHIELD_STRIKE_ID,
      target: TARGET,
    })

    expect(result.followUp).toEqual([])
    expect(result.finished).toBeNull()
  })
})

describe('StartBattle — siembra de presencia (HU-21, contrato §4.2)', () => {
  it('solo queda ausente quien no tiene conexion de batalla, desde `startedAt`', async () => {
    const h = finalizationHarness()
    const room = preparingRoom()

    await h.rooms.save(room, 0)

    const connections = {
      isConnected: (roomId: string, playerId: string): boolean =>
        roomId === ROOM_ID && playerId === 'a1',
    }
    const useCase = new StartBattle(
      h.rooms,
      clock,
      heroesPort(),
      scriptedRandom([0]),
      {
        publish: () => undefined,
      },
      h.presence,
      h.book,
      connections,
    )

    await useCase.execute(ROOM_ID, 'a1')

    const absences = h.presence.absences(ROOM_ID)

    expect(absences.has('a1')).toBe(false)
    expect(absences.get('b1')).toEqual(NOW)
    expect(h.book.due.get(ROOM_ID)).toEqual(new Date(NOW.getTime() + 30_000))
  })
})
