import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { RecoverBattleDeadlines } from '../../src/application/use-cases/RecoverBattleDeadlines'
import { NOW } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'
import { finalizationHarness } from '../fixtures/finalization'

const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs)

/**
 * Recuperacion de vencimientos al arrancar (HU-21, contrato §3 y §4.2):
 * los globales y de turno se derivan de la base; la gracia arranca AHORA para
 * todo participante humano de una batalla en curso (nadie tiene conexion tras
 * un arranque). Escenarios S-09 y S-25.
 */
describe('RecoverBattleDeadlines — reinicio y batallas previas (S-09, S-25)', () => {
  it('S-09: siembra la gracia de todos los humanos desde AHORA y registra el proximo vencimiento', async () => {
    const h = finalizationHarness()
    const room = battleWithCombat({ teamSizes: [1, 1] })

    await h.rooms.save(room, 0)

    const now = at(100_000)
    const recover = new RecoverBattleDeadlines(h.rooms, h.presence, h.book, {
      now: () => now,
    })

    await expect(recover.execute()).resolves.toBe(1)

    const absences = h.presence.absences(room.id)

    expect(absences.get('a1')).toEqual(now)
    expect(absences.get('b1')).toEqual(now)
    // El vencimiento de turno (NOW + 30 s) es anterior a la gracia (now + 30 s):
    // se registra ese, y el primer barrido lo procesara de inmediato.
    expect(h.book.due.get(room.id)).toEqual(at(30_000))
    expect(h.book.dueRooms(now)).toContain(room.id)
  })

  it('S-25: una sala IN_BATTLE vencida queda registrada para el primer barrido', async () => {
    const h = finalizationHarness()
    const room = battleWithCombat()
    const snapshot = room.toSnapshot()
    const battle = snapshot.battle

    if (battle === null) {
      throw new Error('La sala de prueba necesita batalla.')
    }

    // Equivalente a una batalla anterior a HU-21: su turno empezo con la
    // batalla, pero aqui el turno ya se renovo para aislar el vencimiento
    // global. Lo que importa: el vencimiento se deriva de la base y no se pierde
    // al reiniciar.
    const renewed = BattleRoom.restore({
      ...snapshot,
      battle: { ...battle, turnStartedAt: at(330_000) },
    })

    await h.rooms.save(renewed, 0)

    const now = at(400_000)
    const recover = new RecoverBattleDeadlines(h.rooms, h.presence, h.book, {
      now: () => now,
    })

    await recover.execute()

    expect(h.book.dueRooms(now)).toContain(room.id)
    expect(h.book.due.get(room.id)).toEqual(at(360_000))
  })

  it('ignora las salas que no estan IN_BATTLE (una FINISHED no se vigila)', async () => {
    const h = finalizationHarness()
    const room = battleWithCombat()
    const persisted = await h.rooms.save(room, 0)
    const finished = persisted.finish({ reason: 'ELIMINATION', winnerTeamLabel: 'A' }, at(10_000))

    await h.rooms.save(finished, persisted.version)

    const recover = new RecoverBattleDeadlines(h.rooms, h.presence, h.book, {
      now: () => at(100_000),
    })

    await expect(recover.execute()).resolves.toBe(0)
    expect(h.book.due.size).toBe(0)
    expect(h.presence.absences(room.id).size).toBe(0)
  })
})
