import { Int32 } from 'mongodb'

import {
  toDocument,
  toSnapshot,
  type BattleRoomDocument,
} from '../../src/adapters/outbound/persistence/battle-room-mapping'
import type { BattleRoomSnapshot } from '../../src/domain/entities/BattleRoom'

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
