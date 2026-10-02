import {
  BattleRoom,
  type CreateTournamentRoomInput,
  type TournamentTeamInput,
} from '../../src/domain/entities/BattleRoom'
import {
  InvalidModeCompositionError,
  InvalidTournamentRosterError,
  RoomNotCancellableError,
  RoomNotJoinableError,
  RoomNotLeavableError,
} from '../../src/domain/errors/BattleRoomErrors'

/**
 * `BattleRoom.createTournamentRoom()` (Management#517, EN de
 * `tournament-rooms`): roster FIJO de 4 jugadores humanos (2 equipos de 2) y
 * aislamiento del lobby publico (join/leave/cancel, listado de disponibles).
 */
describe('BattleRoom.createTournamentRoom', () => {
  const AT = new Date('2026-10-01T10:00:00.000Z')
  const ROOM_ID = '22222222-2222-4222-8222-222222222222'
  const CREATED_BY = 'tournament:T1'

  const member = (playerId: string) => ({
    playerId,
    heroId: `heroe-de-${playerId}`,
    heroLoadoutVersion: 0,
    displayName: `nombre-de-${playerId}`,
  })

  const baseInput = (
    overrides: Partial<CreateTournamentRoomInput> = {},
  ): CreateTournamentRoomInput => ({
    operationId: 'T1:E1',
    tournamentId: 'T1',
    encounterId: 'T1:E1',
    requestHash: 'a'.repeat(64),
    teams: [
      { teamId: 'equipo1', members: [member('p1'), member('p2')] },
      { teamId: 'equipo2', members: [member('p3'), member('p4')] },
    ],
    ...overrides,
  })

  it('crea la sala YA en PREPARING, nunca en WAITING_FOR_PLAYERS', () => {
    const room = BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput(), AT)

    expect(room.id).toBe(ROOM_ID)
    expect(room.status).toBe('PREPARING')
    expect(room.mode).toBe('PVP')
    expect(room.createdBy).toBe(CREATED_BY)
    expect(room.reward.amount).toBe(0)
    expect(room.version).toBe(0)
  })

  it('usa los teamId declarados como label, con los 4 jugadores resueltos', () => {
    const room = BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput(), AT)

    expect(room.teams[0].label).toBe('equipo1')
    expect(room.teams[1].label).toBe('equipo2')
    expect(room.teams[0].participants.map((p) => p.playerId)).toEqual(['p1', 'p2'])
    expect(room.teams[1].participants.map((p) => p.playerId)).toEqual(['p3', 'p4'])
    expect(room.teams[0].participants[0]).toMatchObject({
      kind: 'HUMAN',
      heroId: 'heroe-de-p1',
      displayName: 'nombre-de-p1',
    })
  })

  it('persiste la identificacion de torneo en `tournament`', () => {
    const room = BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput(), AT)

    expect(room.tournament).toEqual({
      operationId: 'T1:E1',
      tournamentId: 'T1',
      encounterId: 'T1:E1',
      requestHash: 'a'.repeat(64),
    })
  })

  it('sobrevive a un round-trip de toSnapshot()/restore()', () => {
    const room = BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput(), AT)
    const restored = BattleRoom.restore(room.toSnapshot())

    expect(restored.tournament).toEqual(room.tournament)
    expect(restored.status).toBe('PREPARING')
  })

  it('una sala de lobby normal (create()) nunca lleva `tournament`', () => {
    const room = BattleRoom.create(
      ROOM_ID,
      'jugador-1',
      { mode: 'PVP', teamConfigs: [{ capacity: 1 }, { capacity: 1 }], reward: { amount: 0 } },
      AT,
    )

    expect(room.tournament).toBeNull()
  })

  const equipo2 = (): TournamentTeamInput => ({
    teamId: 'equipo2',
    members: [member('p3'), member('p4')],
  })

  it.each<[string, readonly TournamentTeamInput[]]>([
    ['menos de 2 equipos', [{ teamId: 'equipo1', members: [member('p1'), member('p2')] }]],
    [
      'mas de 2 equipos',
      [
        { teamId: 'equipo1', members: [member('p1'), member('p2')] },
        equipo2(),
        { teamId: 'equipo3', members: [member('p5'), member('p6')] },
      ],
    ],
    ['un equipo con 1 jugador', [{ teamId: 'equipo1', members: [member('p1')] }, equipo2()]],
    [
      'un equipo con 3 jugadores ("nunca hasta 4")',
      [{ teamId: 'equipo1', members: [member('p1'), member('p2'), member('p5')] }, equipo2()],
    ],
    [
      'dos equipos con el mismo teamId',
      [
        { teamId: 'equipo1', members: [member('p1'), member('p2')] },
        { teamId: 'equipo1', members: [member('p3'), member('p4')] },
      ],
    ],
  ])('rechaza un roster que no es FIJO de 4 (2+2): %s', (_caso, teams) => {
    expect(() =>
      BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput({ teams }), AT),
    ).toThrow(InvalidTournamentRosterError)
  })

  it('rechaza el mismo jugador declarado en los dos equipos', () => {
    const teams: readonly [TournamentTeamInput, TournamentTeamInput] = [
      { teamId: 'equipo1', members: [member('p1'), member('p2')] },
      { teamId: 'equipo2', members: [member('p1'), member('p4')] },
    ]

    expect(() =>
      BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput({ teams }), AT),
    ).toThrow(InvalidModeCompositionError)
  })

  describe('aislamiento del lobby publico', () => {
    it('leave() se rechaza SIEMPRE, aunque el estado (PREPARING) lo admitiria en una sala normal', () => {
      const room = BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput(), AT)

      expect(() => room.leave('p1')).toThrow(RoomNotLeavableError)
    })

    it('join() se rechaza porque la sala nunca esta WAITING_FOR_PLAYERS', () => {
      const room = BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput(), AT)

      expect(() => room.join('p5', null, AT)).toThrow(RoomNotJoinableError)
    })

    it('cancel() se rechaza porque la sala nunca esta WAITING_FOR_PLAYERS', () => {
      const room = BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput(), AT)

      expect(() => room.cancel(CREATED_BY)).toThrow(RoomNotCancellableError)
    })

    it('isAvailable() es siempre false (status nunca es WAITING_FOR_PLAYERS)', () => {
      const room = BattleRoom.createTournamentRoom(ROOM_ID, CREATED_BY, baseInput(), AT)

      expect(room.isAvailable()).toBe(false)
    })
  })
})
