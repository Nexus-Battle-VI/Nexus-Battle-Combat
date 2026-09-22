import { InMemoryBattlePresenceRegistry } from '../../src/adapters/outbound/system/InMemoryBattlePresenceRegistry'

const a = new Date('2026-09-21T10:00:00.000Z')
const b = new Date('2026-09-21T10:00:05.000Z')

/**
 * Presencia en memoria (HU-21, contrato §4.2): varias pestanas cuentan una vez,
 * la gracia corre desde la PRIMERA vez que se perdio la ultima conexion y
 * `clear` libera la sala al terminar.
 */
describe('InMemoryBattlePresenceRegistry', () => {
  it('marca ausente y conserva el `since` MAS ANTIGUO si vuelve a marcar', () => {
    const presence = new InMemoryBattlePresenceRegistry()

    presence.markAbsent('sala', 'ana', b)
    presence.markAbsent('sala', 'ana', a)

    expect(presence.absences('sala').get('ana')).toEqual(a)
  })

  it('markPresent cancela la gracia solo de ese jugador', () => {
    const presence = new InMemoryBattlePresenceRegistry()

    presence.markAbsent('sala', 'ana', a)
    presence.markAbsent('sala', 'bruno', a)
    presence.markPresent('sala', 'ana')

    expect(presence.absences('sala').has('ana')).toBe(false)
    expect(presence.absences('sala').get('bruno')).toEqual(a)
  })

  it('las salas no se mezclan y `absences` devuelve una copia', () => {
    const presence = new InMemoryBattlePresenceRegistry()

    presence.markAbsent('sala-1', 'ana', a)
    presence.markAbsent('sala-2', 'bruno', b)

    const copy = presence.absences('sala-1') as Map<string, Date>

    copy.delete('ana')

    expect(presence.absences('sala-1').get('ana')).toEqual(a)
    expect(presence.absences('sala-2').get('bruno')).toEqual(b)
  })

  it('clear olvida la sala entera y markPresent de una sala desconocida es no-op', () => {
    const presence = new InMemoryBattlePresenceRegistry()

    presence.markAbsent('sala', 'ana', a)
    presence.clear('sala')
    presence.markPresent('otra', 'ana')

    expect(presence.absences('sala').size).toBe(0)
  })
})
