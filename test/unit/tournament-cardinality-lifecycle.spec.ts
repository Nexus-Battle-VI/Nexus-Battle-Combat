import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { PrecombatEligibilityBlockedError } from '../../src/application/errors/PrecombatEligibilityError'
import { PlayerWithoutEquippedHeroError } from '../../src/application/errors/UpstreamErrors'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import { UseSkill } from '../../src/application/use-cases/UseSkill'
import { GetTournamentRoomRecord } from '../../src/application/use-cases/GetTournamentRoomRecord'
import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { InvalidTargetError } from '../../src/domain/errors/BattleErrors'
import { InvalidTournamentRosterError } from '../../src/domain/errors/BattleRoomErrors'
import {
  BATTLE_TIME_LIMIT_MS,
  DISCONNECT_GRACE_MS,
  TURN_TIME_LIMIT_MS,
} from '../../src/domain/policies/BattleTimingPolicy'
import {
  equippedHeroFixture,
  equippedProductNotOwnedBlocker,
  shieldStrikeAbility,
} from '../fixtures/equipped-hero'
import { scriptedSequence } from '../fixtures/battle'
import { indexForEffect, indexForFace } from '../fixtures/basic-attack'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import {
  TOURNAMENT_AT,
  tournamentHarness,
  tournamentRequest,
} from '../fixtures/tournament-cardinality'

describe('salas SOLO/DUO/TRIO por el mismo motor de Combat', () => {
  it.each(['LIFE_PERCENT', 'ABSOLUTE_LIFE'] as const)(
    'TRIO incluye el asiento 2 en el desempate %s y en los seis resultados HU-83',
    async (rule) => {
      const h = tournamentHarness(new InMemoryBattleRoomRepository())
      const request = tournamentRequest('TRIO')
      if (rule === 'ABSOLUTE_LIFE') {
        h.heroes.getEquippedHero.mockImplementation((playerId) => {
          const hero = equippedHeroFixture({
            playerId,
            heroId: `hero-${playerId}`,
            activeEffects: [],
          })
          return Promise.resolve(
            playerId === 'E1-b3'
              ? { ...hero, effectiveStats: { ...hero.effectiveStats, health: 20 } }
              : hero,
          )
        })
      }
      const created = await h.create(request)
      const started = await h.start(created.id, request)
      if (rule === 'LIFE_PERCENT') {
        const attack = new ExecuteBasicAttack(
          h.rooms,
          h.clock,
          scriptedSequence([
            indexForFace(5, 6),
            indexForEffect('GUERRERO_ARMAS', RandomEffectType.Damage, 100),
            indexForFace(4, 4),
          ]),
          new ChannelLock(),
        )
        const actor = started.battle?.currentTurn.playerId
        if (actor === undefined || actor === null) throw new Error('falta actor')
        const hit = await attack.execute({
          roomId: created.id,
          requesterId: actor,
          commandId: 'damage-seat-2',
          target: { teamLabel: 'E1-B', seat: 2 },
        })
        expect(hit.event.payload).toMatchObject({ targetHealth: { before: 40, after: 36 } })
      }
      h.setTime(new Date(TOURNAMENT_AT.getTime() + 360_000))
      for (let i = 0; i < 2; i += 1) {
        const room = await h.rooms.findById(created.id)
        if (room === null) throw new Error('falta sala')
        const next = room.settleDeadlines(h.clock.now(), new Map())
        if (next !== room) await h.rooms.save(next, room.version)
      }
      const record = await new GetTournamentRoomRecord(h.rooms).execute(created.id, 0)
      expect(record.result).toMatchObject({
        reason: 'TIME_LIMIT',
        outcome: 'WIN',
        winnerTeamLabel: 'E1-A',
        tiebreak: rule,
      })
      expect(record.result?.teams).toMatchObject([
        { remainingHealth: 120, maxHealth: 120 },
        {
          remainingHealth: rule === 'LIFE_PERCENT' ? 116 : 100,
          maxHealth: rule === 'LIFE_PERCENT' ? 120 : 100,
        },
      ])
      expect(record.result?.participants).toHaveLength(6)
      expect(record.result?.participants.filter((p) => p.result === 'WON')).toHaveLength(3)
      expect(record.result?.participants.filter((p) => p.result === 'LOST')).toHaveLength(3)
    },
  )

  it('el sexto humano conserva la gracia de desconexion de 30 segundos', async () => {
    const h = tournamentHarness(new InMemoryBattleRoomRepository())
    const request = tournamentRequest('TRIO')
    const created = await h.create(request)
    await h.start(created.id, request)
    const room = await h.rooms.findById(created.id)
    if (room === null) throw new Error('falta sala')
    const absent = new Map([['E1-b3', TOURNAMENT_AT]])
    expect(room.settleDeadlines(new Date(TOURNAMENT_AT.getTime() + 29_999), absent)).toBe(room)
    const finished = room.settleDeadlines(new Date(TOURNAMENT_AT.getTime() + 30_000), absent)
    expect(finished.result).toMatchObject({
      reason: 'DISCONNECTION',
      winnerTeamLabel: 'E1-A',
      disconnected: { teamLabel: 'E1-B', seat: 2 },
    })
    expect(finished.result?.participants).toHaveLength(6)
  })

  it.each(['SOLO', 'DUO', 'TRIO'] as const)(
    '%s resuelve todos los humanos y construye la cola completa',
    async (mode) => {
      const h = tournamentHarness(new InMemoryBattleRoomRepository())
      const request = tournamentRequest(mode)
      const created = await h.create(request)
      const started = await h.start(created.id, request)
      const playerIds = request.teams.flatMap((team) => team.memberIds)
      expect(created.tournament).toEqual({ contractVersion: 3, mode, teamSize: request.teamSize })
      expect(started.mode).toBe('PVP')
      expect(started.teams.map((team) => team.capacity)).toEqual([
        request.teamSize,
        request.teamSize,
      ])
      expect(started.battle?.turnOrder.map((entry) => entry.playerId).sort()).toEqual(
        [...playerIds].sort(),
      )
      expect(
        new Set(
          started.battle?.turnOrder.map((entry) => `${entry.teamLabel}:${String(entry.seat)}`),
        ).size,
      ).toBe(playerIds.length)
      expect(started.battle?.combatants).toHaveLength(playerIds.length)
      expect(h.accounts.getBattleProfile.mock.calls.map(([id]) => id).sort()).toEqual(
        [...playerIds].sort(),
      )
      for (const id of playerIds) {
        expect(
          h.heroes.getEquippedHero.mock.calls.filter(([calledId]) => calledId === id),
        ).toHaveLength(2)
      }
      expect(h.commitments.commits).toHaveLength(playerIds.length)
      expect(created.reward.amount).toBe(0)
      expect(created.stakePool.total).toBe(0)
    },
  )

  it.each([
    [0, 0],
    [4, 4],
    [1, 2],
    [2, 3],
  ])('rechaza %i-%i antes de Account/Inventory', async (left, right) => {
    const h = tournamentHarness(new InMemoryBattleRoomRepository())
    const request = tournamentRequest('TRIO')
    const memberIds = (length: number, prefix: string) =>
      Array.from({ length }, (_, i) => `${prefix}${String(i)}`)
    await expect(
      h.create({
        ...request,
        teams: [
          { teamId: 'A', memberIds: memberIds(left, 'a') },
          { teamId: 'B', memberIds: memberIds(right, 'b') },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidTournamentRosterError)
    expect(h.accounts.getBattleProfile).not.toHaveBeenCalled()
    expect(h.heroes.getEquippedHero).not.toHaveBeenCalled()
  })

  it('rechaza repetidos normalizados, equipos iguales y tamanos contradictorios antes de upstream', async () => {
    const h = tournamentHarness(new InMemoryBattleRoomRepository())
    const request = tournamentRequest('TRIO')
    for (const invalid of [
      { ...request, teamSize: 2 },
      {
        ...request,
        teams: [request.teams[0], { ...request.teams[1], teamId: request.teams[0].teamId }],
      },
      {
        ...request,
        teams: [request.teams[0], { ...request.teams[1], memberIds: [' E1-a1 ', 'b2', 'b3'] }],
      },
    ]) {
      await expect(h.create(invalid)).rejects.toBeInstanceOf(InvalidTournamentRosterError)
    }
    expect(h.accounts.getBattleProfile).not.toHaveBeenCalled()
    expect(h.heroes.getEquippedHero).not.toHaveBeenCalled()
  })

  it.each(['missing', 'ineligible'] as const)(
    'el sexto heroe %s impide iniciar, sin cola ni compromisos',
    async (failure) => {
      const h = tournamentHarness(new InMemoryBattleRoomRepository())
      const request = tournamentRequest('TRIO')
      const created = await h.create(request)
      h.heroes.getEquippedHero.mockImplementation((playerId) =>
        Promise.resolve(
          playerId === 'E1-b3'
            ? failure === 'missing'
              ? null
              : equippedHeroFixture({
                  playerId,
                  heroId: `hero-${playerId}`,
                  ready: false,
                  blockers: [equippedProductNotOwnedBlocker],
                })
            : equippedHeroFixture({ playerId, heroId: `hero-${playerId}`, activeEffects: [] }),
        ),
      )
      await expect(h.start(created.id, request)).rejects.toBeInstanceOf(
        failure === 'missing' ? PlayerWithoutEquippedHeroError : PrecombatEligibilityBlockedError,
      )
      const room = await h.rooms.findById(created.id)
      expect(room?.status).toBe('PREPARING')
      expect(room?.events).toHaveLength(0)
      expect(h.commitments.commits).toHaveLength(0)
    },
  )

  it('seis actores ejecutan ataque/habilidad, incluido el asiento 2; HU-83 conserva los seis y las secuencias', async () => {
    const h = tournamentHarness(new InMemoryBattleRoomRepository())
    const request = tournamentRequest('TRIO')
    const created = await h.create(request)
    const started = await h.start(created.id, request)
    const lock = new ChannelLock()
    const sequence = scriptedSequence(Array<number>(100).fill(1))
    const attack = new ExecuteBasicAttack(h.rooms, h.clock, sequence, lock)
    const skill = new UseSkill(h.rooms, h.clock, sequence, lock, attack)
    const actors: string[] = []
    for (let i = 0; i < 6; i += 1) {
      const current = (await h.rooms.findById(created.id))?.battleView()?.currentTurn
      if (current?.playerId === null || current === undefined) throw new Error('falta actor humano')
      actors.push(current.playerId)
      const input = {
        roomId: created.id,
        requesterId: current.playerId,
        commandId: `action-${String(i)}`,
        target: { teamLabel: current.teamLabel === 'E1-A' ? 'E1-B' : 'E1-A', seat: 2 },
      }
      if (i === 0) {
        await expect(
          attack.execute({ ...input, target: { ...input.target, seat: 3 } }),
        ).rejects.toBeInstanceOf(InvalidTargetError)
      }
      const result =
        i % 2 === 0
          ? await attack.execute(input)
          : await skill.execute({ ...input, abilityId: shieldStrikeAbility.abilityId })
      expect(result.replayed).toBe(false)
      const replay =
        i % 2 === 0
          ? await attack.execute(input)
          : await skill.execute({ ...input, abilityId: shieldStrikeAbility.abilityId })
      expect(replay.replayed).toBe(true)
    }
    expect(new Set(actors).size).toBe(6)
    expect(actors).toEqual(started.battle?.turnOrder.map((entry) => entry.playerId))
    const record = await new GetTournamentRoomRecord(h.rooms).execute(created.id, 0)
    expect(record.teams.flatMap((team) => team.participants)).toHaveLength(6)
    expect(record.events.items.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(record.events.items.map((event) => event.type)).toEqual([
      'battleStarted',
      'basicAttackResolved',
      'skillUsed',
      'basicAttackResolved',
      'skillUsed',
      'basicAttackResolved',
      'skillUsed',
    ])
  })

  it.each(['SOLO', 'DUO', 'TRIO'] as const)(
    '%s termina exactamente a seis minutos con el desempate comun NO_WINNER',
    async (mode) => {
      const h = tournamentHarness(new InMemoryBattleRoomRepository())
      const request = tournamentRequest(mode)
      const created = await h.create(request)
      await h.start(created.id, request)
      const advance = async (offset: number) => {
        const at = new Date(TOURNAMENT_AT.getTime() + offset)
        h.setTime(at)
        const room = await h.rooms.findById(created.id)
        if (room === null) throw new Error('falta sala')
        const next = room.settleDeadlines(h.clock.now(), new Map())
        return next === room ? room : h.rooms.save(next, room.version)
      }
      for (let time = 30_000; time <= 330_000; time += 30_000) await advance(time)
      expect((await advance(359_999)).status).toBe('IN_BATTLE')
      const finished = await advance(360_000)
      expect(finished.result).toMatchObject({
        reason: 'TIME_LIMIT',
        outcome: 'NO_WINNER',
        winnerTeamLabel: null,
      })
      expect(finished.events.filter((event) => event.type === 'battleFinished')).toHaveLength(1)
      expect(BattleRoom.restore(finished.toSnapshot()).toSnapshot()).toEqual(finished.toSnapshot())
      h.heroes.getEquippedHero.mockClear()
      expect((await h.start(created.id, request)).status).toBe('FINISHED')
      expect((await h.create(request)).id).toBe(created.id)
      expect(h.heroes.getEquippedHero).not.toHaveBeenCalled()
      expect(BATTLE_TIME_LIMIT_MS).toBe(360_000)
      expect(TURN_TIME_LIMIT_MS).toBe(30_000)
      expect(DISCONNECT_GRACE_MS).toBe(30_000)
    },
  )

  it('E1/E2 concurrentes mantienen salas, colas y replay independientes', async () => {
    const h = tournamentHarness(new InMemoryBattleRoomRepository())
    const requests = [tournamentRequest('TRIO', 'E1'), tournamentRequest('TRIO', 'E2')]
    const creations = await Promise.all(
      requests.flatMap((request) => [h.create(request), h.create(request), h.create(request)]),
    )
    const e1 = creations[0]!
    const e2 = creations[3]!
    expect(new Set(creations.map((room) => room.id)).size).toBe(2)
    await Promise.all(
      requests.flatMap((request, i) => [
        h.start(i === 0 ? e1.id : e2.id, request),
        h.start(i === 0 ? e1.id : e2.id, request),
      ]),
    )
    expect(h.publisher.published).toHaveLength(2)
    for (const [index, request] of requests.entries()) {
      const dto = await h.create(request)
      expect(dto.status).toBe('IN_BATTLE')
      expect(dto.id).toBe(index === 0 ? e1.id : e2.id)
      expect(
        dto.battle?.turnOrder.every((entry) => entry.playerId?.startsWith(request.encounterId)),
      ).toBe(true)
    }
  })
})
