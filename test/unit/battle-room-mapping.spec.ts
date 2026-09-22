import { Int32 } from 'mongodb'

import {
  toDocument,
  toSnapshot,
  type BattleRoomDocument,
} from '../../src/adapters/outbound/persistence/battle-room-mapping'
import { BattleRoom, type BattleRoomSnapshot } from '../../src/domain/entities/BattleRoom'
import { DomainError } from '../../src/domain/errors/DomainError'
import { NOW } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'

/**
 * Mapeo puro Mongo <-> instantanea de dominio (HU-14/HU-15.2). Cubre
 * especificamente la migracion ADITIVA de `displayName`
 * (`003-battle-rooms-participant-display-name.ts`, HU-15.2, DP-2): un
 * documento escrito ANTES de esa migracion no tiene el campo, y
 * `toSnapshot()` debe tratarlo como `null` sin lanzar -- ningun documento
 * existente necesita reescribirse.
 */
const BASE_DOCUMENT: BattleRoomDocument = {
  _id: '11111111-1111-4111-8111-111111111111',
  mode: 'PVP',
  status: 'WAITING_FOR_PLAYERS',
  teams: [
    {
      label: 'A',
      capacity: new Int32(1),
      participants: [
        {
          kind: 'HUMAN',
          playerId: 'jugador-1',
          heroId: 'heroe-1',
          joinedAt: new Date('2026-09-19T00:00:00.000Z'),
          // displayName AUSENTE a proposito: simula un documento escrito por
          // 001/002, antes de que displayName existiera.
        },
      ],
    },
    { label: 'B', capacity: new Int32(1), participants: [] },
  ],
  reward: { amount: 0 },
  createdBy: 'jugador-1',
  createdAt: new Date('2026-09-19T00:00:00.000Z'),
  version: new Int32(0),
}

describe('battle-room-mapping (HU-15.2, migracion 003, retrocompatibilidad)', () => {
  it('un documento sin displayName (pre-003) se traduce a displayName: null, sin lanzar', () => {
    const snapshot = toSnapshot(BASE_DOCUMENT)

    expect(snapshot.teams[0].participants[0]).toMatchObject({
      playerId: 'jugador-1',
      displayName: null,
    })
  })

  it('un documento sin heroLoadoutVersion (pre-004, HU-16.2) se traduce a heroLoadoutVersion: null, sin lanzar', () => {
    const snapshot = toSnapshot(BASE_DOCUMENT)

    expect(snapshot.teams[0].participants[0]).toMatchObject({
      playerId: 'jugador-1',
      heroLoadoutVersion: null,
    })
  })

  it('toDocument()/toSnapshot() redondean heroLoadoutVersion cuando esta presente (HU-16.2, DP-6)', () => {
    const snapshotWithVersion: BattleRoomSnapshot = {
      ...toSnapshot(BASE_DOCUMENT),
      teams: [
        {
          label: 'A',
          capacity: 1,
          participants: [
            {
              kind: 'HUMAN',
              playerId: 'jugador-1',
              heroId: 'heroe-1',
              heroLoadoutVersion: 3,
              displayName: 'Nombre Visible',
              joinedAt: new Date('2026-09-19T00:00:00.000Z'),
            },
          ],
        },
        { label: 'B', capacity: 1, participants: [] },
      ],
    }

    const document = toDocument(snapshotWithVersion)
    const roundTripped = toSnapshot(document)

    expect(roundTripped.teams[0].participants[0]).toMatchObject({ heroLoadoutVersion: 3 })
  })

  it('toDocument()/toSnapshot() redondean displayName cuando esta presente', () => {
    const snapshotWithDisplayName: BattleRoomSnapshot = {
      ...toSnapshot(BASE_DOCUMENT),
      teams: [
        {
          label: 'A',
          capacity: 1,
          participants: [
            {
              kind: 'HUMAN',
              playerId: 'jugador-1',
              heroId: 'heroe-1',
              displayName: 'Nombre Visible',
              joinedAt: new Date('2026-09-19T00:00:00.000Z'),
            },
          ],
        },
        { label: 'B', capacity: 1, participants: [] },
      ],
    }

    const document = toDocument(snapshotWithDisplayName)
    const roundTripped = toSnapshot(document)

    expect(roundTripped.teams[0].participants[0]).toMatchObject({ displayName: 'Nombre Visible' })
  })
})

describe('battle-room-mapping (HU-21, migracion 009, aditivo y retrocompatible)', () => {
  const AT = new Date('2026-09-21T10:05:00.000Z')
  const finished = (): BattleRoom =>
    battleWithCombat({ health: { 'B#0': 0 } }).finish(
      { reason: 'ELIMINATION', winnerTeamLabel: 'A' },
      AT,
    )

  it('ida y vuelta de una sala FINISHED: el `result` y `turnStartedAt` sobreviven al documento', () => {
    const room = finished()
    const document = toDocument(room.toSnapshot())

    expect(document.result).toMatchObject({ reason: 'ELIMINATION', winnerTeamLabel: 'A' })
    expect(document.battle?.turnStartedAt).toEqual(NOW)

    const roundTripped = toSnapshot(document)

    expect(roundTripped.result).toEqual(room.result)
    expect(roundTripped.battle?.turnStartedAt).toEqual(room.battle?.turnStartedAt)

    const restored = BattleRoom.restore(roundTripped)

    expect(restored.status).toBe('FINISHED')
    expect(restored.result).toEqual(room.result)
  })

  it('un documento anterior a HU-21 (sin `result` ni `turnStartedAt`) se restaura sin lanzar', () => {
    const snapshot = battleWithCombat().toSnapshot()
    const battle = snapshot.battle

    if (battle === null) {
      throw new Error('La sala de prueba necesita batalla.')
    }

    // Documento anterior a HU-21: sin `turnStartedAt`.
    const legacyBattle = { ...battle }

    delete (legacyBattle as { turnStartedAt?: Date }).turnStartedAt

    const legacy: BattleRoomDocument = {
      ...toDocument(snapshot),
      status: 'IN_BATTLE',
      battle: legacyBattle,
    }
    delete (legacy as { result?: unknown }).result

    const roundTripped = toSnapshot(legacy)

    expect(roundTripped.result).toBeNull()
    expect(roundTripped.battle?.turnStartedAt).toEqual(snapshot.battle?.startedAt)
    expect(BattleRoom.restore(roundTripped).status).toBe('IN_BATTLE')
  })

  it('rechaza un `result` incoherente guardado en el documento', () => {
    const document = toDocument(finished().toSnapshot())

    expect(() =>
      toSnapshot({ ...document, result: { ...document.result, reason: 'SURRENDER' } }),
    ).toThrow(DomainError)
  })
})
