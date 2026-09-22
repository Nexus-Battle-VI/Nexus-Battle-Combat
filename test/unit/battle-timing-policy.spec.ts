import {
  BATTLE_TIME_LIMIT_MS,
  DISCONNECT_GRACE_MS,
  TURN_TIME_LIMIT_MS,
  battleDeadline,
  graceDeadline,
  hasReached,
  turnDeadline,
} from '../../src/domain/policies/BattleTimingPolicy'

/**
 * Fronteras de los temporizadores (HU-21, contrato `hu-21-battle-finish-v1`, §3):
 * el limite es INCLUSIVO. `deadline - 1 ms` no vence; `deadline` si.
 */
describe('BattleTimingPolicy — constantes y fronteras (contrato §3)', () => {
  it('las duraciones son las del contrato y no dependen del entorno', () => {
    expect(BATTLE_TIME_LIMIT_MS).toBe(360_000)
    expect(TURN_TIME_LIMIT_MS).toBe(30_000)
    expect(DISCONNECT_GRACE_MS).toBe(30_000)
  })

  it.each([
    ['battleDeadline', battleDeadline, 360_000],
    ['turnDeadline', turnDeadline, 30_000],
    ['graceDeadline', graceDeadline, 30_000],
  ] as const)('%s suma exactamente %i ms al instante recibido', (_label, deadlineOf, expected) => {
    const base = new Date('2026-09-21T10:00:00.000Z')

    expect(deadlineOf(base).toISOString()).toBe(new Date(base.getTime() + expected).toISOString())
  })

  it('no muta la fecha recibida', () => {
    const base = new Date('2026-09-21T10:00:00.000Z')

    battleDeadline(base)
    turnDeadline(base)
    graceDeadline(base)

    expect(base.toISOString()).toBe('2026-09-21T10:00:00.000Z')
  })

  it.each([
    ['vencido hace 1 ms', -1, true],
    ['exactamente el vencimiento', 0, true],
    ['1 ms antes del vencimiento', 1, false],
  ] as const)('hasReached: %s', (_label, offsetFromDeadline, expected) => {
    const deadline = new Date('2026-09-21T10:06:00.000Z')
    const now = new Date(deadline.getTime() - offsetFromDeadline)

    expect(hasReached(now, deadline)).toBe(expected)
  })
})
