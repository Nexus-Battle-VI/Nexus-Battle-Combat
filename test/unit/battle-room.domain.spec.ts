import { BattleRoom, type CreateBattleRoomInput } from '../../src/domain/entities/BattleRoom'
import { DomainError } from '../../src/domain/errors/DomainError'
import { parseBattleRoomStatus } from '../../src/domain/value-objects/BattleRoomStatus'
import {
  InvalidModeCompositionError,
  InvalidRewardError,
  InvalidRoomCapacityError,
  InvalidTeamCapacityError,
  PlayerAlreadyJoinedError,
  RoomCancellationForbiddenError,
  RoomFullError,
  RoomNotCancellableError,
  RoomNotJoinableError,
} from '../../src/domain/errors/BattleRoomErrors'

/**
 * Invariantes de dominio de la sala de batalla (HU-14, RF-14). Cubre la
 * matriz minima de `HU-14.1-Trazabilidad.md` / `HU-14.2-Auditoria-Preimplementacion.md`,
 * seccion L.
 */
describe('BattleRoom', () => {
  const AT = new Date('2026-09-17T10:00:00.000Z')
  const ROOM_ID = '11111111-1111-4111-8111-111111111111'
  const CREATOR = 'jugador-creador'

  const baseInput = (overrides: Partial<CreateBattleRoomInput> = {}): CreateBattleRoomInput => ({
    mode: 'PVP',
    teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
    reward: { amount: 0 },
    ...overrides,
  })

  describe('creaciones validas', () => {
    it('1v1 PVP sin participantes declarados', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput(), AT)

      expect(room.id).toBe(ROOM_ID)
      expect(room.status).toBe('WAITING_FOR_PLAYERS')
      expect(room.teams[0].label).toBe('A')
      expect(room.teams[1].label).toBe('B')
      expect(room.version).toBe(0)
    })

    it('PVE con IA declarada', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({
          mode: 'PVE',
          teamConfigs: [
            { capacity: 2, initialParticipants: [{ kind: 'AI', heroId: 'heroe-1' }] },
            { capacity: 2 },
          ],
        }),
        AT,
      )

      expect(room.teams[0].participants).toHaveLength(1)
      expect(room.teams[0].participants[0]).toMatchObject({ kind: 'AI', heroId: 'heroe-1' })
    })

    it('modalidad grupal valida (2-3)', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({ teamConfigs: [{ capacity: 2 }, { capacity: 3 }] }),
        AT,
      )

      expect(room.totalCapacity()).toBe(5)
    })

    it('capacidad exacta 3 por equipo y capacidad total exacta 6', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({ teamConfigs: [{ capacity: 3 }, { capacity: 3 }] }),
        AT,
      )

      expect(room.totalCapacity()).toBe(6)
    })

    it('recompensa valida', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput({ reward: { amount: 250 } }), AT)

      expect(room.reward.amount).toBe(250)
    })

    it('identificador unico por creacion, estado inicial siempre WAITING_FOR_PLAYERS', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput(), AT)

      expect(room.id).toBe(ROOM_ID)
      expect(room.status).toBe('WAITING_FOR_PLAYERS')
    })

    it('acepta un HUMAN inicial con playerId ya resuelto (responsabilidad del caso de uso, no del dominio)', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({
          teamConfigs: [
            { capacity: 3, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
            { capacity: 3 },
          ],
        }),
        AT,
      )

      expect(room.teams[0].participants[0]).toMatchObject({ kind: 'HUMAN', playerId: CREATOR })
    })
  })

  describe('rechazos', () => {
    it('capacity < 1 -> InvalidTeamCapacityError', () => {
      expect(() =>
        BattleRoom.create(
          ROOM_ID,
          CREATOR,
          baseInput({ teamConfigs: [{ capacity: 0 }, { capacity: 1 }] }),
          AT,
        ),
      ).toThrow(InvalidTeamCapacityError)
    })

    it('capacity > 3 -> InvalidTeamCapacityError', () => {
      expect(() =>
        BattleRoom.create(
          ROOM_ID,
          CREATOR,
          baseInput({ teamConfigs: [{ capacity: 4 }, { capacity: 1 }] }),
          AT,
        ),
      ).toThrow(InvalidTeamCapacityError)
    })

    // NOTA: con exactamente 2 equipos y `capacity` acotada a 1..3 por equipo
    // (`InvalidTeamCapacityError`, verificado ANTES por diseno), la suma
    // maxima posible es 3+3=6 -- `InvalidRoomCapacityError` nunca se puede
    // disparar a traves de `BattleRoom.create()` tal como esta acotado hoy
    // el contrato. Se conserva como defensa en profundidad (HU-14.1,
    // `HU-14.1-Decisiones-Tecnicas.md`, punto 5) y se prueba directamente
    // como clase de error, no via un escenario de creacion irreproducible.
    it('InvalidRoomCapacityError conserva el mensaje esperado (defensa en profundidad, no alcanzable via create())', () => {
      const error = new InvalidRoomCapacityError(7)

      expect(error.message).toContain('7')
      expect(error.name).toBe('InvalidRoomCapacityError')
    })

    it('AI en PVP -> InvalidModeCompositionError', () => {
      expect(() =>
        BattleRoom.create(
          ROOM_ID,
          CREATOR,
          baseInput({
            mode: 'PVP',
            teamConfigs: [{ capacity: 1, initialParticipants: [{ kind: 'AI' }] }, { capacity: 1 }],
          }),
          AT,
        ),
      ).toThrow(InvalidModeCompositionError)
    })

    it('PVE con participantes declarados sin ningun AI -> InvalidModeCompositionError', () => {
      expect(() =>
        BattleRoom.create(
          ROOM_ID,
          CREATOR,
          baseInput({
            mode: 'PVE',
            teamConfigs: [
              { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
              { capacity: 1 },
            ],
          }),
          AT,
        ),
      ).toThrow(InvalidModeCompositionError)
    })

    it('mas initialParticipants que capacity -> InvalidModeCompositionError', () => {
      expect(() =>
        BattleRoom.create(
          ROOM_ID,
          CREATOR,
          baseInput({
            mode: 'PVE',
            teamConfigs: [
              { capacity: 1, initialParticipants: [{ kind: 'AI' }, { kind: 'AI' }] },
              { capacity: 1 },
            ],
          }),
          AT,
        ),
      ).toThrow(InvalidModeCompositionError)
    })

    it('el mismo playerId HUMAN dos veces en la sala -> InvalidModeCompositionError', () => {
      expect(() =>
        BattleRoom.create(
          ROOM_ID,
          CREATOR,
          baseInput({
            teamConfigs: [
              { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
              { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
            ],
          }),
          AT,
        ),
      ).toThrow(InvalidModeCompositionError)
    })

    it('reward.amount < 0 -> InvalidRewardError', () => {
      expect(() =>
        BattleRoom.create(ROOM_ID, CREATOR, baseInput({ reward: { amount: -1 } }), AT),
      ).toThrow(InvalidRewardError)
    })

    it('reward.amount no numerico -> InvalidRewardError', () => {
      expect(() =>
        BattleRoom.create(ROOM_ID, CREATOR, baseInput({ reward: { amount: Number.NaN } }), AT),
      ).toThrow(InvalidRewardError)
    })

    it('modalidad ausente/desconocida -> DomainError', () => {
      expect(() =>
        BattleRoom.create(ROOM_ID, CREATOR, baseInput({ mode: 'DESCONOCIDA' }), AT),
      ).toThrow(DomainError)
    })

    it('numero de equipos distinto de 2 -> DomainError', () => {
      expect(() =>
        BattleRoom.create(ROOM_ID, CREATOR, baseInput({ teamConfigs: [{ capacity: 1 }] }), AT),
      ).toThrow(DomainError)
    })
  })

  describe('isAvailable()', () => {
    it('WAITING_FOR_PLAYERS con cupo -> disponible', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({ teamConfigs: [{ capacity: 1 }, { capacity: 1 }] }),
        AT,
      )

      expect(room.isAvailable()).toBe(true)
    })

    it('sala llena -> no disponible', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({
          teamConfigs: [
            { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
            { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: 'otro-jugador' }] },
          ],
        }),
        AT,
      )

      expect(room.isAvailable()).toBe(false)
    })

    it('CANCELLED -> no disponible', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput(), AT)
      const cancelled = room.cancel(CREATOR)

      expect(cancelled.isAvailable()).toBe(false)
      expect(cancelled.status).toBe('CANCELLED')
    })
  })

  describe('cancel()', () => {
    it('el creador cancela una sala valida', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput(), AT)
      const cancelled = room.cancel(CREATOR)

      expect(cancelled.status).toBe('CANCELLED')
      expect(cancelled.version).toBe(room.version)
    })

    it('quien no es el creador no puede cancelar', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput(), AT)

      expect(() => room.cancel('otro-jugador')).toThrow(RoomCancellationForbiddenError)
    })

    it('una sala ya cancelada no se puede volver a cancelar', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput(), AT)
      const cancelled = room.cancel(CREATOR)

      expect(() => cancelled.cancel(CREATOR)).toThrow(RoomNotCancellableError)
    })
  })

  describe('restore()', () => {
    it('reconstruye una instantanea previamente serializada', () => {
      const created = BattleRoom.create(ROOM_ID, CREATOR, baseInput({ reward: { amount: 10 } }), AT)
      const restored = BattleRoom.restore(created.toSnapshot())

      expect(restored.toSnapshot()).toEqual(created.toSnapshot())
    })
  })

  describe('BattleRoomStatus acepta PREPARING (HU-15.2)', () => {
    it('parseBattleRoomStatus("PREPARING") ya no lanza', () => {
      expect(parseBattleRoomStatus('PREPARING')).toBe('PREPARING')
    })
  })

  describe('join() (HU-15.2, RF-15)', () => {
    const JOINER = 'jugador-que-se-une'

    it('ingreso valido que deja cupo permanece WAITING_FOR_PLAYERS', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({ teamConfigs: [{ capacity: 2 }, { capacity: 2 }] }),
        AT,
      )

      const joined = room.join(JOINER, null, AT)

      expect(joined.status).toBe('WAITING_FOR_PLAYERS')
      expect(joined.totalParticipants()).toBe(1)
      const allParticipants = [...joined.teams[0].participants, ...joined.teams[1].participants]
      expect(allParticipants).toContainEqual(
        expect.objectContaining({ kind: 'HUMAN', playerId: JOINER }),
      )
    })

    it('ingreso que ocupa el ultimo cupo del equipo objetivo, pero no el total de la sala -> WAITING_FOR_PLAYERS', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({ teamConfigs: [{ capacity: 1 }, { capacity: 2 }] }),
        AT,
      )

      const joined = room.join(JOINER, 'A', AT)

      expect(joined.status).toBe('WAITING_FOR_PLAYERS')
      expect(joined.teams[0].totalParticipants).toBe(1)
      expect(joined.teams[0].capacity).toBe(1)
    })

    it('ingreso que ocupa el ultimo cupo TOTAL de la sala -> transicion a PREPARING en la misma mutacion', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({
          teamConfigs: [
            { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
            { capacity: 1 },
          ],
        }),
        AT,
      )

      const joined = room.join(JOINER, null, AT)

      expect(joined.status).toBe('PREPARING')
      expect(joined.totalParticipants()).toBe(joined.totalCapacity())
    })

    it('sala CANCELLED rechaza join -> RoomNotJoinableError', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput(), AT)
      const cancelled = room.cancel(CREATOR)

      expect(() => cancelled.join(JOINER, null, AT)).toThrow(RoomNotJoinableError)
    })

    it('sala PREPARING rechaza join -> RoomNotJoinableError', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({
          teamConfigs: [
            { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
            { capacity: 1 },
          ],
        }),
        AT,
      )
      const preparing = room.join(JOINER, null, AT)
      expect(preparing.status).toBe('PREPARING')

      expect(() => preparing.join('otro-mas', null, AT)).toThrow(RoomNotJoinableError)
    })

    it('team explicito lleno (pero sala con cupo en el otro equipo) -> RoomFullError', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({
          teamConfigs: [
            { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
            { capacity: 2 },
          ],
        }),
        AT,
      )

      expect(() => room.join(JOINER, 'A', AT)).toThrow(RoomFullError)
    })

    it('team explicito inexistente en la sala -> DomainError', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({ teamConfigs: [{ capacity: 1 }, { capacity: 1 }] }),
        AT,
      )

      expect(() => room.join(JOINER, 'Z', AT)).toThrow(DomainError)
    })

    it('jugador ya participante (mismo playerId) -> PlayerAlreadyJoinedError', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({ teamConfigs: [{ capacity: 2 }, { capacity: 2 }] }),
        AT,
      )
      const joined = room.join(JOINER, null, AT)

      expect(() => joined.join(JOINER, 'B', AT)).toThrow(PlayerAlreadyJoinedError)
    })

    it('el creador ya presente en la sala no puede unirse de nuevo -> PlayerAlreadyJoinedError', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({
          teamConfigs: [
            { capacity: 2, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
            { capacity: 2 },
          ],
        }),
        AT,
      )

      expect(() => room.join(CREATOR, null, AT)).toThrow(PlayerAlreadyJoinedError)
    })

    it('asignacion automatica sin team: ocupa el primer equipo con cupo, orden [A, B]', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({
          teamConfigs: [
            { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
            { capacity: 2 },
          ],
        }),
        AT,
      )

      const joined = room.join(JOINER, null, AT)

      expect(joined.teams[0].totalParticipants).toBe(1)
      expect(joined.teams[1].totalParticipants).toBe(1)
      expect(joined.teams[1].participants[0]).toMatchObject({ kind: 'HUMAN', playerId: JOINER })
    })

    it('nunca totalParticipants supera totalCapacity tras un join', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({ teamConfigs: [{ capacity: 1 }, { capacity: 1 }] }),
        AT,
      )

      const joined = room.join(JOINER, null, AT)

      expect(joined.totalParticipants()).toBeLessThanOrEqual(joined.totalCapacity())
    })

    it('joinedAt del participante nuevo es el `at` recibido, nunca inventado por el dominio', () => {
      const room = BattleRoom.create(
        ROOM_ID,
        CREATOR,
        baseInput({ teamConfigs: [{ capacity: 1 }, { capacity: 1 }] }),
        AT,
      )
      const joinAt = new Date('2026-09-18T00:00:00.000Z')

      const joined = room.join(JOINER, null, joinAt)
      const newParticipant = [
        ...joined.teams[0].participants,
        ...joined.teams[1].participants,
      ].find((participant) => participant.playerId === JOINER)

      expect(newParticipant?.joinedAt).toEqual(joinAt)
    })
  })

  describe('regresion HU-14 (create/cancel siguen intactos tras HU-15.2)', () => {
    it('create() sigue produciendo WAITING_FOR_PLAYERS con version 0', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput(), AT)

      expect(room.status).toBe('WAITING_FOR_PLAYERS')
      expect(room.version).toBe(0)
    })

    it('cancel() sigue funcionando y produciendo CANCELLED', () => {
      const room = BattleRoom.create(ROOM_ID, CREATOR, baseInput(), AT)
      const cancelled = room.cancel(CREATOR)

      expect(cancelled.status).toBe('CANCELLED')
    })

    it('duplicado HUMAN declarado en create() sigue lanzando InvalidModeCompositionError (no PlayerAlreadyJoinedError)', () => {
      expect(() =>
        BattleRoom.create(
          ROOM_ID,
          CREATOR,
          baseInput({
            teamConfigs: [
              { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
              { capacity: 1, initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR }] },
            ],
          }),
          AT,
        ),
      ).toThrow(InvalidModeCompositionError)
    })
  })
})
