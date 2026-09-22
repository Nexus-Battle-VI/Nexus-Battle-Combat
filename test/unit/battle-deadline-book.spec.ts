import { InMemoryBattleDeadlineBook } from '../../src/adapters/outbound/system/InMemoryBattleDeadlineBook'

const early = new Date('2026-09-21T10:00:30.000Z')
const late = new Date('2026-09-21T10:06:00.000Z')

/**
 * Libro de vencimientos (HU-21, contrato §3): `ensureDueBy` conserva el MAS
 * TEMPRANO; `setDue` reemplaza. `dueRooms` es inclusivo con el instante exacto.
 */
describe('InMemoryBattleDeadlineBook', () => {
  it('ensureDueBy conserva el vencimiento mas temprano aunque llegue uno tardio', () => {
    const book = new InMemoryBattleDeadlineBook()

    book.ensureDueBy('sala', late)
    book.ensureDueBy('sala', early)

    expect(book.dueRooms(late)).toEqual(['sala'])
    expect(book.dueRooms(early)).toEqual(['sala'])
    expect(book.dueRooms(new Date(early.getTime() - 1))).toEqual([])
  })

  it('setDue REEMPLAZA: es la reprogramacion real tras liquidar', () => {
    const book = new InMemoryBattleDeadlineBook()

    book.ensureDueBy('sala', early)
    book.setDue('sala', late)

    expect(book.dueRooms(early)).toEqual([])
    expect(book.dueRooms(late)).toEqual(['sala'])
  })

  it('cancel libera la sala y dueRooms solo devuelve las vencidas', () => {
    const book = new InMemoryBattleDeadlineBook()

    book.ensureDueBy('vencida', early)
    book.ensureDueBy('futura', late)
    book.cancel('vencida')

    expect(book.dueRooms(late)).toEqual(['futura'])
  })
})
