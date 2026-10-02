import { randomUUID } from 'node:crypto'

import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type {
  BattleDropInventoryPort,
  BattleDropInventorySnapshot,
  BattleDropTransferCommand,
  BattleDropTransferReceipt,
} from '../../src/application/ports/BattleDropInventoryPort'

/**
 * Doble del inventario de drops para las pruebas de Combat (HU-30).
 *
 * REGISTRA cada llamada en lugar de tragarsela, igual que
 * `recordingBattleCommitments` (HU-29): lo que hay que probar en el cableado
 * del modulo es QUE SE LLAMA al arrancar la batalla, no el cliente HTTP real
 * (que tiene su propia prueba unitaria). Sin equipamiento declarado para un
 * jugador, el candidato queda vacio: ningun drop es posible, que es el
 * comportamiento por defecto correcto para las suites que no ejercitan HU-30.
 */
export interface RecordingBattleDropInventory extends BattleDropInventoryPort {
  readonly captures: Omit<BattleDropInventorySnapshot, 'equipment'>[]
  readonly transfers: BattleDropTransferCommand[]
  readonly closedBattles: string[]
  /** Candidatos equipados por `battleId::playerId`; vacio si no se declara. */
  readonly equipmentByKey: Map<string, BattleDropInventorySnapshot['equipment']>
  /** Cuando es `true`, capturar falla como si Player/Inventory no respondiera. */
  failCapture: boolean
}

const key = (battleId: string, playerId: string): string => `${battleId}::${playerId}`

export const recordingBattleDropInventory = (): RecordingBattleDropInventory => {
  const captures: Omit<BattleDropInventorySnapshot, 'equipment'>[] = []
  const transfers: BattleDropTransferCommand[] = []
  const closedBattles: string[] = []
  const equipmentByKey = new Map<string, BattleDropInventorySnapshot['equipment']>()

  const recorder: RecordingBattleDropInventory = {
    captures,
    transfers,
    closedBattles,
    equipmentByKey,
    failCapture: false,
    capture: (command) => {
      if (recorder.failCapture) {
        return Promise.reject(new UpstreamServiceError('player-inventory', 'no_alcanzable'))
      }

      captures.push(command)

      return Promise.resolve({
        ...command,
        equipment: equipmentByKey.get(key(command.battleId, command.playerId)) ?? [],
      })
    },
    find: (battleId, playerId) =>
      Promise.resolve({
        battleId,
        playerId,
        heroId: `heroe-de-${playerId}`,
        loadoutVersion: 0,
        equipment: equipmentByKey.get(key(battleId, playerId)) ?? [],
      }),
    transfer: (command) => {
      transfers.push(command)

      const receipt: BattleDropTransferReceipt = {
        ...command,
        operationId: randomUUID(),
        productId: `producto-de-${command.productInstanceId}`,
        itemId: `item-de-${command.productInstanceId}`,
        creditedAt: new Date().toISOString(),
      }

      return Promise.resolve(receipt)
    },
    closeBattle: (battleId) => {
      closedBattles.push(battleId)

      return Promise.resolve()
    },
  }

  return recorder
}
