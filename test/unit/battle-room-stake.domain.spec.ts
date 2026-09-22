import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { DomainError } from '../../src/domain/errors/DomainError'
import {
  InvalidStakeAmountError,
  StakeNotAllowedInPveError,
} from '../../src/domain/errors/StakeErrors'
import type { ParticipantStakeInput } from '../../src/domain/value-objects/ParticipantStake'

const CREATOR = 'a1'
const AT = new Date('2026-09-21T10:00:00.000Z')
const HOLD = 'battle:room-1:player:a1:stake:reserve'

/** Apuesta declarada por el cliente + `holdOperationId` resuelto por la aplicacion. */
const declaredStake = (amount: number | undefined): ParticipantStakeInput | undefined =>
  amount === undefined ? undefined : { amount, holdOperationId: HOLD }

const createPvp = (stakes?: Record<string, number>): BattleRoom =>
  BattleRoom.create(
    '11111111-1111-4111-8111-111111111111',
    CREATOR,
    {
      mode: 'PVP',
      teamConfigs: [
        {
          capacity: 1,
          initialParticipants: [
            { kind: 'HUMAN', playerId: CREATOR, stake: declaredStake(stakes?.a1) },
          ],
        },
        { capacity: 1 },
      ],
      reward: { amount: 0 },
    },
    AT,
  )

/** Sala PVP sin participantes declarados, para las pruebas de `join`. */
const createEmptyPvp = (): BattleRoom =>
  BattleRoom.create(
    '11111111-1111-4111-8111-111111111111',
    CREATOR,
    { mode: 'PVP', teamConfigs: [{ capacity: 1 }, { capacity: 1 }], reward: { amount: 0 } },
    AT,
  )

describe('BattleRoom + apuesta (HU-23, WP-C2)', () => {
  it('un participante declarado con apuesta nace PENDING_RESERVE y pasa a ACTIVE al confirmar Wallet', () => {
    const room = createPvp({ a1: 10 })
    const pending = room.stakeOf(CREATOR)

    expect(pending).toMatchObject({
      amount: 10,
      holdOperationId: 'battle:room-1:player:a1:stake:reserve',
      status: 'PENDING_RESERVE',
    })

    const activated = room.withStakesActivated()

    expect(activated.stakeOf(CREATOR)?.status).toBe('ACTIVE')
    expect(activated.stakesAtRisk()).toEqual([
      {
        teamLabel: 'A',
        seat: 0,
        playerId: 'a1',
        amount: 10,
        holdOperationId: 'battle:room-1:player:a1:stake:reserve',
        status: 'ACTIVE',
      },
    ])
  })

  it('un monto 0 no crea apuesta (D5: 0 = no apostar)', () => {
    const room = createPvp({ a1: 0 })

    expect(room.stakeOf(CREATOR)).toBeNull()
    expect(room.stakesAtRisk()).toEqual([])
  })

  it('rechaza un monto negativo o no entero con INVALID_AMOUNT', () => {
    expect(() => createPvp({ a1: -5 })).toThrow(InvalidStakeAmountError)
    expect(() => createPvp({ a1: 1.5 })).toThrow(InvalidStakeAmountError)
  })

  it('una sala PVE con apuesta se rechaza con STAKE_NOT_ALLOWED_IN_PVE (D4)', () => {
    expect(() =>
      BattleRoom.create(
        '11111111-1111-4111-8111-111111111111',
        CREATOR,
        {
          mode: 'PVE',
          teamConfigs: [
            {
              capacity: 1,
              initialParticipants: [{ kind: 'HUMAN', playerId: CREATOR, stake: declaredStake(10) }],
            },
            { capacity: 1, initialParticipants: [{ kind: 'AI' }] },
          ],
          reward: { amount: 0 },
        },
        AT,
      ),
    ).toThrow(StakeNotAllowedInPveError)
  })

  it('join con apuesta: el participante entra PENDING_RESERVE', () => {
    const room = createEmptyPvp()
    const joined = room.join(CREATOR, 'A', AT, 'Nombre', 'heroe', 3, declaredStake(7))

    expect(joined.stakeOf(CREATOR)).toMatchObject({ amount: 7, status: 'PENDING_RESERVE' })
    expect(joined.withStakesActivated().stakeOf(CREATOR)?.status).toBe('ACTIVE')
  })

  it('join con monto 0 no crea apuesta', () => {
    const room = createEmptyPvp()
    const joined = room.join(CREATOR, 'A', AT, 'Nombre', 'heroe', 3, declaredStake(0))

    expect(joined.stakeOf(CREATOR)).toBeNull()
  })

  it('join en una sala PVE con apuesta se rechaza ANTES de crear el participante', () => {
    const room = BattleRoom.create(
      '11111111-1111-4111-8111-111111111111',
      CREATOR,
      {
        mode: 'PVE',
        teamConfigs: [{ capacity: 2 }, { capacity: 2, initialParticipants: [{ kind: 'AI' }] }],
        reward: { amount: 0 },
      },
      AT,
    )

    expect(() => room.join('b1', 'A', AT, 'Nombre', 'heroe', 3, declaredStake(10))).toThrow(
      StakeNotAllowedInPveError,
    )
    expect(room.stakeOf('b1')).toBeNull()
  })

  it('withStakeStatuses actualiza solo los holds de la sala y exige que existan', () => {
    const room = createPvp({ a1: 10 }).withStakesActivated()

    const released = room.withStakeStatuses([{ holdOperationId: HOLD, status: 'RELEASED' }])

    expect(released.stakeOf(CREATOR)?.status).toBe('RELEASED')
    expect(() =>
      room.withStakeStatuses([{ holdOperationId: 'hold-ajeno', status: 'RELEASED' }]),
    ).toThrow(DomainError)
  })

  it('cancelar y abandonar NO cambian el estado de la apuesta: sigue ACTIVE hasta que Wallet confirme', () => {
    // Contrato §9: el estado persistido es la intencion (ACTIVE = pendiente de
    // liberar/liquidar); un PENDING_RELEASE no existe en §4.2.
    const room = createPvp({ a1: 10 }).withStakesActivated()

    expect(room.cancel(CREATOR).stakeOf(CREATOR)?.status).toBe('ACTIVE')
    expect(room.leave(CREATOR).stakeOf(CREATOR)).toBeNull()
  })
})
