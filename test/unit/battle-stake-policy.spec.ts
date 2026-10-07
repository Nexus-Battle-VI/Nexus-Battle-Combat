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

  // Pasada de estabilizacion economica (secciones 7-10 del brief): un
  // ganador SIN apuesta propia YA SI participa del reparto del pozo -- antes
  // quedaba excluido (ver historial), que era precisamente la asimetria
  // reportada. `holdId: null` para b2 confirma que Wallet lo acredita sin
  // referenciar ningun hold suyo (no tiene ninguno).
  it('un ganador sin apuesta propia SI recibe su parte del pozo (holdId: null, sin hold que liberar)', () => {
    const room = finishedRoom({
      teamSizes: [1, 2],
      winnerTeamLabel: 'B',
      stakes: { a1: 10, b1: 5 },
    })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: 'a1', outcome: 'CAPTURED', amount: 10 }),
        expect.objectContaining({
          playerId: 'b1',
          holdId: expect.stringContaining('b1'),
          outcome: 'CREDITED',
          amount: 5,
        }),
        expect.objectContaining({ playerId: 'b2', holdId: null, outcome: 'CREDITED', amount: 5 }),
      ]),
    )
  })

  it('un perdedor sin apuesta no se captura (no aparece); un ganador CON apuesta propia siempre libera su propia reserva (aunque le toque 0)', () => {
    const room = finishedRoom({ teamSizes: [2, 1], winnerTeamLabel: 'A', stakes: { a1: 10 } })

    const settlement = settlementOf(room)

    // a2 (ganador SIN apuesta, pool 0) no aporta ninguna entrada: no tiene
    // hold que liberar y no hay nada que cobrar.
    expect(settlement?.entries).toEqual([
      expect.objectContaining({ playerId: 'a1', outcome: 'CREDITED', amount: 0 }),
    ])
  })

  it('si SOLO el perdedor aposto, el ganador (sin apuesta propia) recibe igual el pozo completo -- ya NO devuelve null', () => {
    const room = finishedRoom({ stakes: { b1: 10 } })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual([
      expect.objectContaining({ playerId: 'b1', outcome: 'CAPTURED', amount: 10 }),
      expect.objectContaining({ playerId: 'a1', holdId: null, outcome: 'CREDITED', amount: 10 }),
    ])
  })

  it('sin ninguna apuesta devuelve null', () => {
    expect(settlementOf(finishedRoom())).toBeNull()
  })

  it('NO_WINNER devuelve null: se libera, no se liquida (D3)', () => {
    const room = timedOutRoom({ stakes: { a1: 10, b1: 10 } })

    expect(settlementOf(room)).toBeNull()
  })

  // Auditoria de la pasada de estabilizacion economica: `stakeSettlementFor`
  // NUNCA recibe `createdBy` -- solo `BattleResult` (teamLabel/seat/result) y
  // las `stakes`. Es estructuralmente IMPOSIBLE que esta funcion distinga al
  // creador de la sala (`a1` en este fixture, ver `test/fixtures/battle.ts`)
  // de un invitado. Estas pruebas lo demuestran de forma explicita para
  // cerrar la sospecha reportada de asimetria owner/invitado: el creador
  // pierde su apuesta exactamente igual que cualquier invitado, y el rival
  // ganador la recibe completa.
  it('EL CREADOR (a1) apuesta y PIERDE: se captura igual que cualquier invitado, el rival la recibe completa', () => {
    const room = finishedRoom({ winnerTeamLabel: 'B', stakes: { a1: 8 } })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual([
      expect.objectContaining({ playerId: 'a1', outcome: 'CAPTURED', amount: 8 }),
      expect.objectContaining({ playerId: 'b1', outcome: 'CREDITED', amount: 8 }),
    ])
  })

  it('EL CREADOR (a1) apuesta y GANA: recibe exactamente lo apostado por el invitado que perdio', () => {
    const room = finishedRoom({ winnerTeamLabel: 'A', stakes: { a1: 8, b1: 8 } })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: 'b1', outcome: 'CAPTURED', amount: 8 }),
        expect.objectContaining({ playerId: 'a1', outcome: 'CREDITED', amount: 8 }),
      ]),
    )
  })

  it('SOLO el invitado (b1, no creador) apuesta y PIERDE: se captura igual que si apostara el creador', () => {
    const room = finishedRoom({ winnerTeamLabel: 'A', stakes: { b1: 8 } })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual([
      expect.objectContaining({ playerId: 'b1', outcome: 'CAPTURED', amount: 8 }),
      expect.objectContaining({ playerId: 'a1', outcome: 'CREDITED', amount: 8 }),
    ])
  })

  it('SOLO el invitado (b1, no creador) apuesta y GANA: recibe su propia apuesta de vuelta (recuperar no es "ganancia nueva", ver BattleCreditsPolicy)', () => {
    const room = finishedRoom({ winnerTeamLabel: 'B', stakes: { b1: 8 } })

    const settlement = settlementOf(room)

    // Sin perdedor con apuesta, el pozo es 0: b1 solo recupera su propio
    // hold (`CREDITED amount: 0`, ver "un perdedor sin apuesta no se
    // captura"), nunca se capta nada de a1 porque a1 no aposto.
    expect(settlement?.entries).toEqual([
      expect.objectContaining({ playerId: 'b1', outcome: 'CREDITED', amount: 0 }),
    ])
  })

  it('ambos apuestan montos distintos: la liquidacion no depende de quien creo la sala', () => {
    const room = finishedRoom({ winnerTeamLabel: 'A', stakes: { a1: 5, b1: 7 } })

    const settlement = settlementOf(room)

    expect(settlement?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: 'b1', outcome: 'CAPTURED', amount: 7 }),
        expect.objectContaining({ playerId: 'a1', outcome: 'CREDITED', amount: 7 }),
      ]),
    )
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
