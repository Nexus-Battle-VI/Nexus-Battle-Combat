import { stakeSettlementFor } from '../../src/domain/policies/BattleStakePolicy'
import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { finishedRoom, timedOutRoom } from '../fixtures/battle'

const resultOf = (room: BattleRoom): NonNullable<BattleRoom['result']> => {
  if (room.result === null) {
    throw new Error('La sala de prueba no tiene resultado.')
  }

  return room.result
}

const settlementOf = (room: BattleRoom) => stakeSettlementFor(resultOf(room), room.stakesAtRisk())

describe('BattleStakePolicy (HU-23, D2 y §5.3)', () => {
  it('1v1 simetrico: el perdedor se captura y el ganador recibe exactamente lo mismo', () => {
    const room = finishedRoom({ stakes: { a1: 10, b1: 10 } })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: 'b1', outcome: 'CAPTURED', amount: 10 }),
        expect.objectContaining({ playerId: 'a1', outcome: 'CREDITED', amount: 10 }),
      ]),
    )
  })

  it('1v1 asimetrico: el pozo es lo apostado por el perdedor, no lo del ganador', () => {
    const room = finishedRoom({ stakes: { a1: 10, b1: 25 } })

    const settlement = settlementOf(room)
    const credited = settlement?.entries.find((entry) => entry.outcome === 'CREDITED')

    expect(credited).toMatchObject({ playerId: 'a1', amount: 25 })
  })

  it('2v2: el pozo se reparte en partes IGUALES entre los ganadores con apuesta (S-08)', () => {
    const room = finishedRoom({
      teamSizes: [2, 2],
      winnerTeamLabel: 'B',
      stakes: { a1: 10, a2: 20, b1: 5, b2: 5 },
    })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: 'a1', outcome: 'CAPTURED', amount: 10 }),
        expect.objectContaining({ playerId: 'a2', outcome: 'CAPTURED', amount: 20 }),
        expect.objectContaining({ playerId: 'b1', outcome: 'CREDITED', amount: 15 }),
        expect.objectContaining({ playerId: 'b2', outcome: 'CREDITED', amount: 15 }),
      ]),
    )
  })

  it('el resto no divisible va de a un credito a los ganadores de asiento mas bajo', () => {
    const room = finishedRoom({
      teamSizes: [1, 2],
      winnerTeamLabel: 'B',
      stakes: { a1: 31, b1: 1, b2: 1 },
    })

    const settlement = settlementOf(room)
    const credited = settlement?.entries.filter((entry) => entry.outcome === 'CREDITED')

    // Pozo 31 entre 2 ganadores con apuesta: 15 + 16, el extra al asiento menor.
    expect(credited).toEqual([
      expect.objectContaining({ playerId: 'b1', amount: 16 }),
      expect.objectContaining({ playerId: 'b2', amount: 15 }),
    ])
  })

  it('un ganador sin apuesta propia no recibe nada del pozo (y no aparece en la liquidacion)', () => {
    const room = finishedRoom({
      teamSizes: [1, 2],
      winnerTeamLabel: 'B',
      stakes: { a1: 10, b1: 5 },
    })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual([
      expect.objectContaining({ playerId: 'a1', outcome: 'CAPTURED', amount: 10 }),
      expect.objectContaining({ playerId: 'b1', outcome: 'CREDITED', amount: 10 }),
    ])
    expect(settlement?.entries.some((entry) => entry.playerId === 'b2')).toBe(false)
  })

  it('un perdedor sin apuesta no se captura (no aparece)', () => {
    const room = finishedRoom({ teamSizes: [2, 1], winnerTeamLabel: 'A', stakes: { a1: 10 } })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual([
      expect.objectContaining({ playerId: 'a1', outcome: 'CREDITED', amount: 0 }),
    ])
  })

  it('si ningun ganador aposto, el pozo no tiene destinatario: null (lo libera el llamador)', () => {
    const room = finishedRoom({ stakes: { b1: 10 } })

    expect(settlementOf(room)).toBeNull()
  })

  it('sin ninguna apuesta devuelve null', () => {
    expect(settlementOf(finishedRoom())).toBeNull()
  })

  it('NO_WINNER devuelve null: se libera, no se liquida (D3)', () => {
    const room = timedOutRoom({ stakes: { a1: 10, b1: 10 } })

    expect(settlementOf(room)).toBeNull()
  })

  it('la suma capturada es EXACTAMENTE la suma acreditada (suma cero)', () => {
    const room = finishedRoom({
      teamSizes: [3, 2],
      winnerTeamLabel: 'B',
      stakes: { a1: 7, a2: 3, a3: 11, b1: 4, b2: 9 },
    })

    const settlement = settlementOf(room)
    const sum = (outcome: string): number =>
      (settlement?.entries ?? [])
        .filter((entry) => entry.outcome === outcome)
        .reduce((total, entry) => total + entry.amount, 0)

    expect(sum('CAPTURED')).toBe(21)
    expect(sum('CREDITED')).toBe(21)
  })
})
