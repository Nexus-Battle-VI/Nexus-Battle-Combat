import type {
  BattleDropInventoryPort,
  BattleDropInventorySnapshot,
  BattleDropTransferCommand,
  BattleDropTransferReceipt,
} from '../../../application/ports/BattleDropInventoryPort'
import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import { getInternalJson, postInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'
import { toBattleDropOperationId } from './battle-drop-operation-id'

const SERVICE = 'player-inventory'
const BASE = '/api/internal/v1/inventory/battle-drops'
const invalid = (): UpstreamServiceError => new UpstreamServiceError(SERVICE, 'respuesta_invalida')

const recordOf = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

const stringOf = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') throw invalid()
  return value
}

const integerOf = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw invalid()
  return value
}

const snapshotOf = (body: unknown): BattleDropInventorySnapshot => {
  const value = recordOf(body)
  if (!Array.isArray(value.equipment)) throw invalid()
  return {
    battleId: stringOf(value.battleId),
    playerId: stringOf(value.playerId),
    heroId: stringOf(value.heroId),
    loadoutVersion: integerOf(value.loadoutVersion),
    equipment: value.equipment.map((raw: unknown) => {
      const item = recordOf(raw)
      const chance = integerOf(item.dropChanceBasisPoints)
      if (chance > 10_000) throw invalid()
      return {
        productInstanceId: stringOf(item.productInstanceId),
        productId: stringOf(item.productId),
        itemId: stringOf(item.itemId),
        dropChanceBasisPoints: chance,
      }
    }),
  }
}

export class PlayerInventoryBattleDropHttpClient implements BattleDropInventoryPort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async capture(
    command: Omit<BattleDropInventorySnapshot, 'equipment'>,
  ): Promise<BattleDropInventorySnapshot> {
    const result = await postInternalJson(SERVICE, `${BASE}/snapshots`, command, this.options)
    if (result.outcome !== 'ok') throw new UpstreamServiceError(SERVICE, result.outcome)
    const snapshot = snapshotOf(result.body)
    if (snapshot.battleId !== command.battleId || snapshot.playerId !== command.playerId) throw invalid()
    return snapshot
  }

  async find(battleId: string, playerId: string): Promise<BattleDropInventorySnapshot> {
    const result = await getInternalJson(
      SERVICE,
      `${BASE}/snapshots/${encodeURIComponent(battleId)}/${encodeURIComponent(playerId)}`,
      this.options,
    )
    if (!result.found) throw new UpstreamServiceError(SERVICE, 'snapshot_no_encontrado')
    const snapshot = snapshotOf(result.body)
    if (snapshot.battleId !== battleId || snapshot.playerId !== playerId) throw invalid()
    return snapshot
  }

  async transfer(command: BattleDropTransferCommand): Promise<BattleDropTransferReceipt> {
    const operationId = toBattleDropOperationId(command.battleId, command.defeatEventSeq)
    const result = await postInternalJson(
      SERVICE,
      `${BASE}/transfers`,
      { ...command, operationId },
      this.options,
    )
    if (result.outcome !== 'ok') throw new UpstreamServiceError(SERVICE, result.outcome)
    const receipt = recordOf(result.body)
    if (
      stringOf(receipt.operationId) !== operationId ||
      stringOf(receipt.productInstanceId) !== command.productInstanceId ||
      stringOf(receipt.battleId) !== command.battleId
    ) {
      throw invalid()
    }
    return {
      ...command,
      operationId,
      productId: stringOf(receipt.productId),
      itemId: stringOf(receipt.itemId),
      creditedAt: stringOf(receipt.creditedAt),
    }
  }

  async closeBattle(battleId: string): Promise<void> {
    const result = await postInternalJson(
      SERVICE,
      `${BASE}/battles/${encodeURIComponent(battleId)}/close`,
      {},
      this.options,
    )
    if (result.outcome !== 'ok') throw new UpstreamServiceError(SERVICE, result.outcome)
  }
}
